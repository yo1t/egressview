using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Session;

namespace EgressView.Agent.Core;

public sealed class EtwNetworkCollector : IAsyncDisposable
{
    private static readonly Guid KernelNetwork = new("7DD42A49-5329-4832-8DFD-43D979153A88");
    // Microsoft-Windows-Kernel-Process. Only the process keyword is enabled:
    // thread and image-load events would multiply the volume for nothing.
    private static readonly Guid KernelProcess = new("22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716");
    private const ulong ProcessKeyword = 0x10;
    private static readonly HashSet<string> VpnProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "tailscaled", "wireguard", "openvpn", "openvpnserv", "nordvpn-service", "protonvpn.service",
    };
    private readonly ObservationPipeline pipeline;
    private readonly ProcessNameResolver processNames = new();
    private readonly DeferredProcessObservations deferredNames = new();
    private readonly object interfaceGate = new();
    private Dictionary<string, InterfaceInfo> interfaces = new(StringComparer.OrdinalIgnoreCase);
    private TraceEventSession? session;
    private Task? processing;
    private long eventsSeen, eventsIgnored, interfaceUnresolved, inboundMulticastIgnored;
    private string? error;
    private string? processNameSourceError;

    public EtwNetworkCollector(ObservationPipeline pipeline)
    {
        this.pipeline = pipeline;
        RefreshInterfaces();
        NetworkChange.NetworkAddressChanged += OnNetworkChanged;
    }

    public bool IsActive => session is not null && error is null;
    public long EventsSeen => Interlocked.Read(ref eventsSeen);
    public long EventsIgnored => Interlocked.Read(ref eventsIgnored);
    public long InterfaceUnresolved => Interlocked.Read(ref interfaceUnresolved);
    /// Inbound group datagrams, dropped before storage. Counted rather
    /// than discarded quietly: the number says how much is being left out
    /// on purpose, so the choice stays visible instead of looking like a
    /// collection gap.
    public long InboundMulticastIgnored => Interlocked.Read(ref inboundMulticastIgnored);
    public int EventsLost { get; private set; }
    public string? Error => error;
    /// Why process start events are unavailable, when they are. Network
    /// collection continues without them; names just fall back to querying,
    /// which loses the processes that exit first. Reporting it keeps that a
    /// visible reduction rather than a silent one.
    public string? ProcessNameSourceError => processNameSourceError;
    public long ProcessStartsObserved => processNames.ObservedStarts;

    public void Start()
    {
        if (session is not null) throw new InvalidOperationException("ETW collector is already running.");
        var sessionName = $"EgressViewAgentNetwork-{Environment.ProcessId}";
        try { TraceEventSession.GetActiveSession(sessionName)?.Stop(); } catch { }
        try
        {
            session = new TraceEventSession(sessionName) { StopOnDispose = true };
            session.EnableProvider(KernelNetwork, TraceEventLevel.Verbose, ulong.MaxValue);
            // Process starts are an enrichment, not the collection itself. If
            // they cannot be enabled the Agent still observes traffic, so this
            // failure is recorded and carried on from rather than thrown.
            try
            {
                session.EnableProvider(KernelProcess, TraceEventLevel.Informational, ProcessKeyword);
            }
            catch (Exception ex)
            {
                processNameSourceError = $"{ex.GetType().Name}: {ex.Message}";
            }
            session.Source.Dynamic.All += Dispatch;
            processing = Task.Run(() =>
            {
                try { session.Source.Process(); }
                catch (Exception ex) { error = $"{ex.GetType().Name}: {ex.Message}"; }
            });
        }
        catch (Exception ex)
        {
            error = $"{ex.GetType().Name}: {ex.Message}";
            session?.Dispose();
            session = null;
            throw new InvalidOperationException("ETW network collection could not start. Polling fallback is disabled.", ex);
        }
    }

    public CollectorSnapshot Enrich(CollectorSnapshot snapshot) => snapshot with
    {
        EtwSessionActive = IsActive,
        EtwEventsSeen = EventsSeen,
        EtwEventsIgnored = EventsIgnored,
        InterfaceUnresolved = InterfaceUnresolved,
        InboundMulticastIgnored = InboundMulticastIgnored,
        EtwEventsLost = EventsLost,
        CollectorError = Error,
        NamesFromStartEvents = processNames.ObservedStarts,
        NamesFromCache = processNames.CacheHits,
        NamesNeverSeen = processNames.NeverSeen,
        NamesNeverSeenAtStartup = processNames.NeverSeenAtStartup,
        NamesNeverSeenAfterStartup = processNames.NeverSeenAfterStartup,
        NamesNeverSeenAfterStartProbeMiss = processNames.NeverSeenAfterStartProbeMiss,
        NamesNeverSeenWithoutStartEvent = processNames.NeverSeenWithoutStartEvent,
        NamesInvalidProcessId = processNames.InvalidProcessId,
        NamesExpired = processNames.Expired,
        NamesPidReuseRejected = processNames.PidReuseRejected,
        NamesDeferredPending = deferredNames.Pending,
        NamesDeferred = deferredNames.Deferred,
        NamesRecoveredFromStop = deferredNames.Recovered,
        NamesDeferredExpired = deferredNames.Expired,
        NamesDeferredOverflow = deferredNames.Overflow,
        ProcessNameSourceError = processNameSourceError,
        State = Error is not null || EventsLost > 0 || snapshot.PersistenceFailures > 0 ? "degraded" : snapshot.State,
    };

    private void Dispatch(TraceEvent e)
    {
        Submit(deferredNames.Expire(DateTimeOffset.UtcNow));
        if (e.ProviderGuid == KernelProcess) { RecordProcessLifecycle(e); return; }
        Record(e);
    }

    /// Names a process from its lifecycle events, before its traffic is seen.
    ///
    /// The two events carry different things. **ProcessStart has no image
    /// name** -- only the PID and create time -- so the name has to be queried
    /// there, which is safe because the process is certainly alive at that
    /// instant. ProcessStop does carry the image name, and is used as a second
    /// chance for events still in the channel.
    private void RecordProcessLifecycle(TraceEvent e)
    {
        var started = e.EventName.Contains("ProcessStart", StringComparison.OrdinalIgnoreCase);
        var stopped = e.EventName.Contains("ProcessStop", StringComparison.OrdinalIgnoreCase);
        if (!started && !stopped) return;

        var pid = Payload(e, "ProcessID") is { } raw && int.TryParse(raw, out var parsed) ? parsed : 0;
        if (pid <= 0) return;
        var createdAt = CreateTime(e) ?? e.TimeStamp.ToUniversalTime();

        if (started)
        {
            processNames.Learn(pid, createdAt);
            return;
        }

        var stoppedName = processNames.Observe(pid, Payload(e, "ImageName"), createdAt);
        if (stoppedName is not null)
        {
            foreach (var observation in deferredNames.Complete(pid, createdAt, stoppedName))
            {
                var localInterface = FindInterface(observation.LocalAddress);
                pipeline.TrySubmit(observation with
                {
                    Layer = IsVpnTransport(stoppedName, localInterface) ? ObservationLayer.VpnTransport : ObservationLayer.Logical,
                });
            }
        }
    }

    /// The process create time distinguishes one use of a PID from the next,
    /// so it is preferred over the event timestamp where the provider gives it.
    private static DateTimeOffset? CreateTime(TraceEvent e) =>
        Payload(e, "CreateTime") is { } raw && DateTimeOffset.TryParse(raw, out var parsed)
            ? parsed.ToUniversalTime()
            : null;

    private static string? Payload(TraceEvent e, string name)
    {
        try { return e.PayloadByName(name)?.ToString(); }
        catch (Exception) { return null; }
    }

    private void Record(TraceEvent e)
    {
        Interlocked.Increment(ref eventsSeen);
        var direction = DirectionOf(e.EventName);
        if (direction == Direction.Neutral) { Interlocked.Increment(ref eventsIgnored); return; }
        var sourceAddress = Address(Raw(e, "saddr"));
        var destinationAddress = Address(Raw(e, "daddr"));
        if (sourceAddress is null || destinationAddress is null) { Interlocked.Increment(ref eventsIgnored); return; }

        var sourcePort = Port(Raw(e, "sport"));
        var destinationPort = Port(Raw(e, "dport"));
        var pid = IntValue(Raw(e, "PID"), e.ProcessID);
        var bytes = LongValue(Raw(e, "size"));
        var sourceMulticast = IsMulticast(sourceAddress);
        var destinationMulticast = IsMulticast(destinationAddress);
        var sourceInterface = FindInterface(sourceAddress);
        var destinationInterface = FindInterface(destinationAddress);

        string localAddress, remoteAddress;
        int localPort, remotePort;
        InterfaceInfo? localInterface;
        if (sourceInterface is not null && destinationInterface is null && !sourceMulticast)
            (localAddress, localPort, remoteAddress, remotePort, localInterface) = (sourceAddress, sourcePort, destinationAddress, destinationPort, sourceInterface);
        else if (destinationInterface is not null && sourceInterface is null && !destinationMulticast)
            (localAddress, localPort, remoteAddress, remotePort, localInterface) = (destinationAddress, destinationPort, sourceAddress, sourcePort, destinationInterface);
        else if (sourceMulticast || destinationMulticast)
        {
            // An inbound group datagram is another device announcing itself.
            // It is not this machine sending anything, which is what this
            // product watches. It also names the sender and the group but not
            // the interface that received it, so it has no local address and
            // can never satisfy the Hub's contract -- it would be stored and
            // then dropped, every time.
            //
            // Outbound multicast is a different thing and is kept: this
            // machine announcing itself is traffic it sent.
            if (direction == Direction.Receive)
            {
                Interlocked.Increment(ref inboundMulticastIgnored);
                return;
            }
            (localAddress, localPort, remoteAddress, remotePort, localInterface) =
                (sourceAddress, sourcePort, destinationAddress, destinationPort, sourceInterface);
        }
        else
        {
            var received = direction == Direction.Receive;
            (localAddress, localPort, remoteAddress, remotePort, localInterface) = received
                ? (destinationAddress, destinationPort, sourceAddress, sourcePort, destinationInterface)
                : (sourceAddress, sourcePort, destinationAddress, destinationPort, sourceInterface);
        }

        if (localInterface is null) Interlocked.Increment(ref interfaceUnresolved);
        // The event timestamp, not the current time: events reach here through
        // a channel, so a short-lived process may already be gone by now and
        // the name has to be judged against when the traffic happened.
        var processName = processNames.Resolve(pid, e.TimeStamp.ToUniversalTime());
        var layer = IsVpnTransport(processName, localInterface) ? ObservationLayer.VpnTransport : ObservationLayer.Logical;
        var observation = new NetworkObservation(
            e.TimeStamp.ToUniversalTime(), pid,
            e.EventName.Contains("UDP", StringComparison.OrdinalIgnoreCase) ? "UDP" : "TCP",
            localAddress, localPort, remoteAddress, remotePort,
            direction == Direction.Send ? bytes : 0, direction == Direction.Receive ? bytes : 0,
            layer, localInterface?.Id, "etw", processName);
        if (processName is null
            && processNames.TryGetUnresolvedStart(pid, out var processStartedAt)
            && deferredNames.TryDefer(observation, processStartedAt, DateTimeOffset.UtcNow))
            return;
        pipeline.TrySubmit(observation);
    }

    private static bool IsVpnTransport(string? processName, InterfaceInfo? localInterface)
    {
        if (localInterface is null || localInterface.IsVirtual) return false;
        return processName is not null && VpnProcesses.Contains(processName);
    }

    private InterfaceInfo? FindInterface(string address)
    {
        var canonical = Canonical(address);
        lock (interfaceGate) return interfaces.GetValueOrDefault(canonical);
    }

    private void OnNetworkChanged(object? sender, EventArgs e) => RefreshInterfaces();
    private void RefreshInterfaces()
    {
        var updated = new Dictionary<string, InterfaceInfo>(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (var nic in NetworkInterface.GetAllNetworkInterfaces())
            {
                var isVirtual = nic.NetworkInterfaceType is NetworkInterfaceType.Tunnel or NetworkInterfaceType.Loopback
                    || nic.Description.Contains("virtual", StringComparison.OrdinalIgnoreCase)
                    || nic.Description.Contains("Tailscale", StringComparison.OrdinalIgnoreCase)
                    || nic.Description.Contains("WireGuard", StringComparison.OrdinalIgnoreCase);
                foreach (var address in nic.GetIPProperties().UnicastAddresses)
                    try { updated[Canonical(address.Address)] = new InterfaceInfo(nic.Id, isVirtual); } catch { }
            }
        }
        catch { }
        lock (interfaceGate) interfaces = updated;
    }

    public async ValueTask DisposeAsync()
    {
        NetworkChange.NetworkAddressChanged -= OnNetworkChanged;
        if (session is null) return;
        try { EventsLost = session.EventsLost; } catch { }
        try { session.Stop(); } catch { }
        if (processing is not null) await processing.WaitAsync(TimeSpan.FromSeconds(10));
        Submit(deferredNames.Drain());
        session.Dispose();
        session = null;
    }

    private void Submit(IEnumerable<NetworkObservation> observations)
    {
        foreach (var observation in observations) pipeline.TrySubmit(observation);
    }

    private enum Direction { Send, Receive, Neutral }
    private sealed record InterfaceInfo(string Id, bool IsVirtual);
    private static Direction DirectionOf(string name) => name.Contains("Datasent", StringComparison.OrdinalIgnoreCase) ? Direction.Send : name.Contains("Datareceived", StringComparison.OrdinalIgnoreCase) ? Direction.Receive : Direction.Neutral;
    private static object? Raw(TraceEvent e, string name) { try { return e.PayloadNames?.FirstOrDefault(n => string.Equals(n, name, StringComparison.OrdinalIgnoreCase)) is { } n ? e.PayloadByName(n) : null; } catch { return null; } }
    private static string? Address(object? value) => value switch { byte[] b when b.Length is 4 or 16 => new IPAddress(b).ToString(), uint n => new IPAddress(BitConverter.GetBytes(n)).ToString(), int n => new IPAddress(BitConverter.GetBytes((uint)n)).ToString(), string s => s, _ => null };
    private static int Port(object? value) { var raw = IntValue(value, 0); var masked = (uint)raw & 0xffff; return (int)(((masked & 0xff) << 8) | ((masked >> 8) & 0xff)); }
    private static int IntValue(object? value, int fallback) => value is null || !int.TryParse(value.ToString(), out var parsed) ? fallback : parsed;
    private static long LongValue(object? value) => value is null || !long.TryParse(value.ToString(), out var parsed) ? 0 : parsed;
    private static string Canonical(string address) => IPAddress.TryParse(address, out var ip) ? Canonical(ip) : address;
    private static string Canonical(IPAddress ip) => ip.AddressFamily == AddressFamily.InterNetworkV6 && ip.ScopeId != 0 ? new IPAddress(ip.GetAddressBytes()).ToString() : ip.ToString();
    private static bool IsMulticast(string address) { if (!IPAddress.TryParse(address, out var ip)) return false; return ip.AddressFamily == AddressFamily.InterNetworkV6 ? ip.IsIPv6Multicast : ip.GetAddressBytes()[0] is >= 224 and <= 239; }
}
