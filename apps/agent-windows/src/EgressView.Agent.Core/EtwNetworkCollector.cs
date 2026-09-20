using System.Diagnostics;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Diagnostics.Tracing;
using Microsoft.Diagnostics.Tracing.Session;

namespace EgressView.Agent.Core;

public enum EtwConnectionEventKind { Other, Attempted, Accepted, Disconnect, Close }

public static class EtwConnectionEvents
{
    public static EtwConnectionEventKind Classify(string eventName) => eventName switch
    {
        var name when name.Contains("Connectionattempted", StringComparison.OrdinalIgnoreCase) => EtwConnectionEventKind.Attempted,
        var name when name.Contains("Connectionaccepted", StringComparison.OrdinalIgnoreCase) => EtwConnectionEventKind.Accepted,
        var name when name.Contains("Disconnect", StringComparison.OrdinalIgnoreCase) => EtwConnectionEventKind.Disconnect,
        var name when name.Contains("Close", StringComparison.OrdinalIgnoreCase) => EtwConnectionEventKind.Close,
        _ => EtwConnectionEventKind.Other,
    };
}

public sealed class EtwNetworkCollector : IAsyncDisposable
{
    private static readonly Guid KernelNetwork = new("7DD42A49-5329-4832-8DFD-43D979153A88");
    // Microsoft-Windows-Kernel-Process. Only the process keyword is enabled:
    // thread and image-load events would multiply the volume for nothing.
    private static readonly Guid KernelProcess = new("22FB2CD6-0E7B-422B-A0C7-2FAD1FD0E716");
    private static readonly Guid DnsClient = new("1C95126E-7EEA-49A9-A3FE-A378B03DDB4D");

    /// The two keywords this Agent reads: IPv4 and IPv6 traffic.
    ///
    /// The values are the provider's own, from `logman query providers
    /// Microsoft-Windows-Kernel-Network`. Guessed as 0x1 and 0x2 first, which
    /// are bits this provider does not define: the session stayed up, the
    /// other two providers kept delivering, and not one network event arrived
    /// for three minutes. Keywords are not positional.
    private const ulong NetworkKeywords = 0x10 | 0x20;   // IPV4 | IPV6

    /// Total buffer space for the session, and the size of one buffer.
    ///
    /// Both were left at the defaults, and on a busy machine that is not
    /// enough: measured here, 831,786 of 4,400,951 events were lost -- about
    /// nineteen in a hundred. The two ETW counters say which end failed.
    /// RealTimeBuffersLost was zero, so nothing failed to reach this process;
    /// EventsLost was not, which is the count of events a provider could not
    /// write because every buffer was already in use.
    ///
    /// So the fix is buffers, not a faster reader. 64 MB of them, in 128 KB
    /// pieces rather than the default 64 KB, because fewer larger buffers are
    /// returned to the provider in fewer round trips.
    private const int SessionBufferMB = 64;
    private const int SessionBufferQuantumKB = 128;

    /// Whether destination names are read from Windows DNS metadata.
    ///
    /// Turning this off costs more than the names: destinations show as
    /// addresses, and threat matching by domain has nothing to match on.
    /// Matching by address, locations and countries are unaffected, because
    /// those are worked out from the address.
    public bool ReadsHostnames
    {
        get => readsHostnames;
        set
        {
            readsHostnames = value;
            // Turning it off forgets what was already learned, so no new
            // connection is named from names collected before the request.
            if (!value) dnsNames.Forget();
        }
    }

    private bool readsHostnames = true;
    private const ulong ProcessKeyword = 0x10;
    private static readonly HashSet<string> VpnProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "tailscaled", "wireguard", "openvpn", "openvpnserv", "nordvpn-service", "protonvpn.service",
    };
    private readonly ObservationPipeline pipeline;
    private readonly ProcessNameResolver processNames = new();
    private readonly DeferredProcessObservations deferredNames = new();
    private readonly DnsNameCache dnsNames = new();
    private readonly object interfaceGate = new();
    private Dictionary<string, InterfaceInfo> interfaces = new(StringComparer.OrdinalIgnoreCase);
    private TraceEventSession? session;
    private Task? processing;
    private long eventsSeen, eventsIgnored, interfaceUnresolved, inboundMulticastIgnored;
    private long connectionAttempted, connectionAccepted, connectionDisconnected, connectionClosed;
    private string? error;
    private string? processNameSourceError;
    private string? hostnameSourceError;
    private int eventsLost;

    public EtwNetworkCollector(ObservationPipeline pipeline)
    {
        this.pipeline = pipeline;
        RefreshInterfaces();
        NetworkChange.NetworkAddressChanged += OnNetworkChanged;
    }

    public bool IsActive => session is not null && error is null;
    public long EventsSeen => Interlocked.Read(ref eventsSeen);
    public long EventsIgnored => Interlocked.Read(ref eventsIgnored);
    public long ConnectionAttempted => Interlocked.Read(ref connectionAttempted);
    public long ConnectionAccepted => Interlocked.Read(ref connectionAccepted);
    public long ConnectionDisconnected => Interlocked.Read(ref connectionDisconnected);
    public long ConnectionClosed => Interlocked.Read(ref connectionClosed);
    public long InterfaceUnresolved => Interlocked.Read(ref interfaceUnresolved);
    /// Inbound group datagrams, dropped before storage. Counted rather
    /// than discarded quietly: the number says how much is being left out
    /// on purpose, so the choice stays visible instead of looking like a
    /// collection gap.
    public long InboundMulticastIgnored => Interlocked.Read(ref inboundMulticastIgnored);
    public int EventsLost
    {
        get
        {
            try { return session?.EventsLost ?? eventsLost; }
            catch { return eventsLost; }
        }
    }

    /// What was lost before the session settled, and what has been lost since.
    ///
    /// One lost event used to mark the agent as needing attention for the rest
    /// of the run, with the advice "restart the service" -- which produced
    /// another start, and another loss. The two numbers answer different
    /// questions: the first is history, the second is whether collection is
    /// healthy right now.
    public int EventsLostAtStart => startingEventsLost;

    public int EventsLostSinceStart => Math.Max(0, EventsLost - startingEventsLost);

    /// Draws the line between what starting cost and what is being lost now.
    ///
    /// Called from every snapshot rather than by a caller who has to remember:
    /// the last time a method like this existed and nothing called it, half of
    /// P3-102 was missing for weeks and the compiler said nothing.
    private void SettleStartupIfDue()
    {
        if (startupSettled || sessionStartedAt == default) return;
        if (DateTimeOffset.UtcNow - sessionStartedAt < StartupSettlingPeriod) return;
        startingEventsLost = EventsLost;
        startupSettled = true;
    }

    /// Thirty seconds. Long enough for a trace session to reach steady state,
    /// short enough that a real shortfall is not hidden for long.
    private static readonly TimeSpan StartupSettlingPeriod = TimeSpan.FromSeconds(30);

    private int startingEventsLost;
    private bool startupSettled;
    private DateTimeOffset sessionStartedAt;
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
        error = null;
        processNameSourceError = null;
        hostnameSourceError = null;
        var sessionName = $"EgressViewAgentNetwork-{Environment.ProcessId}";
        try { TraceEventSession.GetActiveSession(sessionName)?.Stop(); } catch { }
        try
        {
            session = new TraceEventSession(sessionName)
            {
                StopOnDispose = true,
                BufferSizeMB = SessionBufferMB,
                BufferQuantumKB = SessionBufferQuantumKB,
            };
            // The consumer starts before anything is turned on.
            //
            // Enabling the providers first and reading afterwards leaves a gap
            // in which the kernel fills the buffers and nobody empties them.
            // Measured on this machine: 1,210,217 events lost in that gap, and
            // then not one more for the rest of the run -- the session sat at
            // exactly that number while it went on seeing 300 events a second.
            // The loss was never a capacity problem; it was an ordering one.
            session.Source.Dynamic.All += Dispatch;
            processing = Task.Run(() =>
            {
                try { session.Source.Process(); }
                catch (Exception ex) { error = $"{ex.GetType().Name}: {ex.Message}"; }
            });
            session.EnableProvider(KernelNetwork, TraceEventLevel.Verbose, NetworkKeywords);
            sessionStartedAt = DateTimeOffset.UtcNow;
            startupSettled = false;
            startingEventsLost = 0;
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
            // Off means the provider is never enabled, not that names are
            // enabled and then discarded: a person who turns this off is
            // asking for the names not to be collected, and a subscription
            // that collects them anyway would not honour that.
            if (ReadsHostnames)
            {
                try
                {
                    // Event 3008 contains the requesting PID, query name and the
                    // resolved addresses. This is metadata Windows already has;
                    // no packet payload is captured and reverse DNS is never used.
                    session.EnableProvider(DnsClient, TraceEventLevel.Informational, ulong.MaxValue);
                }
                catch (Exception ex)
                {
                    hostnameSourceError = $"{ex.GetType().Name}: {ex.Message}";
                }
            }
        }
        catch (Exception ex)
        {
            error = $"{ex.GetType().Name}: {ex.Message}";
            session?.Dispose();
            session = null;
            throw new InvalidOperationException("ETW network collection could not start. Polling fallback is disabled.", ex);
        }
    }

    public CollectorSnapshot Enrich(CollectorSnapshot snapshot)
    {
        SettleStartupIfDue();
        return Describe(snapshot);
    }

    private CollectorSnapshot Describe(CollectorSnapshot snapshot) => snapshot with
    {
        EtwSessionActive = IsActive,
        EtwEventsSeen = EventsSeen,
        EtwEventsIgnored = EventsIgnored,
        EtwConnectionAttempted = ConnectionAttempted,
        EtwConnectionAccepted = ConnectionAccepted,
        EtwConnectionDisconnected = ConnectionDisconnected,
        EtwConnectionClosed = ConnectionClosed,
        InterfaceUnresolved = InterfaceUnresolved,
        InboundMulticastIgnored = InboundMulticastIgnored,
        EtwEventsLost = EventsLost,
        EtwEventsLostAtStart = EventsLostAtStart,
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
        HostnamesResolved = dnsNames.CacheHits,
        HostnamesUnavailable = dnsNames.CacheMisses,
        DnsEventsSeen = dnsNames.EventsSeen,
        HostnameSourceError = hostnameSourceError,
        State = Error is not null || EventsLostSinceStart > 0 || snapshot.PersistenceFailures > 0 || hostnameSourceError is not null ? "degraded" : snapshot.State,
    };

    private void Dispatch(TraceEvent e)
    {
        var eventAt = e.TimeStamp.ToUniversalTime();
        // Trace callbacks can arrive well after the event under load. Expiring
        // against wall clock used to discard an observation immediately before
        // its delayed ProcessStop callback supplied the real image name. Give
        // lifecycle completion first refusal, then advance expiry using the ETW
        // event timeline so callback latency does not become data loss.
        if (e.ProviderGuid == KernelProcess)
        {
            RecordProcessLifecycle(e);
            Submit(deferredNames.Expire(eventAt));
            return;
        }
        if (e.ProviderGuid == DnsClient)
        {
            RecordDnsResult(e);
            Submit(deferredNames.Expire(eventAt));
            return;
        }
        Record(e);
        Submit(deferredNames.Expire(eventAt));
    }

    private void RecordDnsResult(TraceEvent e)
    {
        if ((int)e.ID != 3008 || !string.Equals(Payload(e, "QueryStatus"), "0", StringComparison.Ordinal)) return;
        dnsNames.Observe(e.ProcessID, Payload(e, "QueryName"), Payload(e, "QueryResults"), e.TimeStamp.ToUniversalTime());
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
        if (direction == Direction.Neutral)
        {
            switch (EtwConnectionEvents.Classify(e.EventName))
            {
                case EtwConnectionEventKind.Attempted: Interlocked.Increment(ref connectionAttempted); break;
                case EtwConnectionEventKind.Accepted: Interlocked.Increment(ref connectionAccepted); break;
                case EtwConnectionEventKind.Disconnect: Interlocked.Increment(ref connectionDisconnected); break;
                case EtwConnectionEventKind.Close: Interlocked.Increment(ref connectionClosed); break;
            }
            Interlocked.Increment(ref eventsIgnored);
            return;
        }
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

        var sorted = SortEndpoints(sourceAddress, sourcePort, destinationAddress, destinationPort,
            sourceInterface is not null, destinationInterface is not null,
            sourceMulticast, destinationMulticast, direction == Direction.Receive);
        if (sorted is null)
        {
            Interlocked.Increment(ref inboundMulticastIgnored);
            return;
        }
        var (localAddress, localPort, remoteAddress, remotePort, localIsSource) = sorted.Value;
        var localInterface = localIsSource ? sourceInterface : destinationInterface;

        if (localInterface is null) Interlocked.Increment(ref interfaceUnresolved);
        // The event timestamp, not the current time: events reach here through
        // a channel, so a short-lived process may already be gone by now and
        // the name has to be judged against when the traffic happened.
        var processName = processNames.Resolve(pid, e.TimeStamp.ToUniversalTime());
        var remoteHostname = dnsNames.Resolve(pid, remoteAddress, e.TimeStamp.ToUniversalTime());
        var layer = IsVpnTransport(processName, localInterface) ? ObservationLayer.VpnTransport : ObservationLayer.Logical;
        var observation = new NetworkObservation(
            e.TimeStamp.ToUniversalTime(), pid,
            e.EventName.Contains("UDP", StringComparison.OrdinalIgnoreCase) ? "UDP" : "TCP",
            localAddress, localPort, remoteAddress, remotePort,
            direction == Direction.Send ? bytes : 0, direction == Direction.Receive ? bytes : 0,
            layer, localInterface?.Id, "etw", processName, remoteHostname);
        if (processName is null
            && processNames.TryGetUnresolvedStart(pid, out var processStartedAt)
            && deferredNames.TryDefer(observation, processStartedAt, observation.ObservedAt))
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

    /// How long a stop waits for the trace session's processing loop.
    ///
    /// The point past which the stop finishes anyway, not an estimate of how
    /// long the loop takes. Going past it is recorded rather than raised.
    public static readonly TimeSpan StopLimit = TimeSpan.FromSeconds(10);

    /// Whether the last stop gave up waiting for the processing loop.
    public bool StopTimedOut { get; private set; }

    public async Task StopAsync()
    {
        if (session is null) return;
        try { eventsLost = session.EventsLost; } catch { }
        try { session.Stop(); } catch { }
        // Said, not thrown. This runs during tear-down, and an exception here
        // leaves the service through the start handler, which reports a failed
        // start -- so Windows records a stop that worked as a crash that did
        // not happen. Whoever owns the store writes the count; this only has
        // to remember that it happened.
        if (processing is not null)
        {
            try { await processing.WaitAsync(StopLimit); }
            catch (TimeoutException) { StopTimedOut = true; }
        }
        Submit(deferredNames.Drain());
        session.Dispose();
        session = null;
        processing = null;
    }

    public async ValueTask DisposeAsync()
    {
        NetworkChange.NetworkAddressChanged -= OnNetworkChanged;
        await StopAsync();
    }

    /// Which end of an event is this machine, or null to leave it out.
    ///
    /// Pulled out of Record because the bug it had was a bug of order: the
    /// inbound-multicast test sat inside the branch that sorts the ends, and
    /// was reached only when the group was the destination. On a receive event
    /// the group is the *source*, so the branch above it -- "the destination is
    /// ours and the source is not" -- matched first and stored the event.
    ///
    /// The cost was not small. Every process listening on the group is handed
    /// the same datagram, so one broadcast was counted once per listener:
    /// measured on one PC, 490 MiB an hour of the same mDNS traffic charged to
    /// svchost, chrome and ChatGPT alike, which is what made an application
    /// look like it was moving half a gigabyte.
    ///
    /// <returns>
    /// The local end, the remote end, and whether the local end was the
    /// source; null when the event is an inbound group datagram and belongs to
    /// nobody on this machine.
    /// </returns>
    internal static (string LocalAddress, int LocalPort, string RemoteAddress, int RemotePort, bool LocalIsSource)?
        SortEndpoints(string sourceAddress, int sourcePort, string destinationAddress, int destinationPort,
            bool sourceHasInterface, bool destinationHasInterface,
            bool sourceMulticast, bool destinationMulticast, bool received)
    {
        // Asked before the sorting, so the answer cannot depend on which side
        // the group address landed on.
        if (received && (sourceMulticast || destinationMulticast)) return null;

        if (sourceHasInterface && !destinationHasInterface && !sourceMulticast)
            return (sourceAddress, sourcePort, destinationAddress, destinationPort, true);
        if (destinationHasInterface && !sourceHasInterface && !destinationMulticast)
            return (destinationAddress, destinationPort, sourceAddress, sourcePort, false);
        // Outbound multicast is kept: this machine announcing itself is
        // traffic it sent.
        if (sourceMulticast || destinationMulticast)
            return (sourceAddress, sourcePort, destinationAddress, destinationPort, true);
        return received
            ? (destinationAddress, destinationPort, sourceAddress, sourcePort, false)
            : (sourceAddress, sourcePort, destinationAddress, destinationPort, true);
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
