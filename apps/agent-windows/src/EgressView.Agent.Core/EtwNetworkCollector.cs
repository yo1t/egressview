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
    private static readonly HashSet<string> VpnProcesses = new(StringComparer.OrdinalIgnoreCase)
    {
        "tailscaled", "wireguard", "openvpn", "openvpnserv", "nordvpn-service", "protonvpn.service",
    };
    private readonly ObservationPipeline pipeline;
    private readonly object interfaceGate = new();
    private Dictionary<string, InterfaceInfo> interfaces = new(StringComparer.OrdinalIgnoreCase);
    private TraceEventSession? session;
    private Task? processing;
    private long eventsSeen, eventsIgnored, interfaceUnresolved;
    private string? error;

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
    public int EventsLost { get; private set; }
    public string? Error => error;

    public void Start()
    {
        if (session is not null) throw new InvalidOperationException("ETW collector is already running.");
        var sessionName = $"EgressViewAgentNetwork-{Environment.ProcessId}";
        try { TraceEventSession.GetActiveSession(sessionName)?.Stop(); } catch { }
        try
        {
            session = new TraceEventSession(sessionName) { StopOnDispose = true };
            session.EnableProvider(KernelNetwork, TraceEventLevel.Verbose, ulong.MaxValue);
            session.Source.Dynamic.All += Record;
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
        EtwEventsLost = EventsLost,
        CollectorError = Error,
        State = Error is not null || EventsLost > 0 || snapshot.PersistenceFailures > 0 ? "degraded" : snapshot.State,
    };

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
            var received = direction == Direction.Receive;
            (localAddress, localPort, remoteAddress, remotePort, localInterface) = received
                ? ("", destinationPort, sourceAddress, sourcePort, null)
                : (sourceAddress, sourcePort, destinationAddress, destinationPort, sourceInterface);
        }
        else
        {
            var received = direction == Direction.Receive;
            (localAddress, localPort, remoteAddress, remotePort, localInterface) = received
                ? (destinationAddress, destinationPort, sourceAddress, sourcePort, destinationInterface)
                : (sourceAddress, sourcePort, destinationAddress, destinationPort, sourceInterface);
        }

        if (localInterface is null) Interlocked.Increment(ref interfaceUnresolved);
        var layer = IsVpnTransport(pid, localInterface) ? ObservationLayer.VpnTransport : ObservationLayer.Logical;
        pipeline.TrySubmit(new NetworkObservation(
            e.TimeStamp.ToUniversalTime(), pid,
            e.EventName.Contains("UDP", StringComparison.OrdinalIgnoreCase) ? "UDP" : "TCP",
            localAddress, localPort, remoteAddress, remotePort,
            direction == Direction.Send ? bytes : 0, direction == Direction.Receive ? bytes : 0,
            layer, localInterface?.Id, "etw"));
    }

    private bool IsVpnTransport(int pid, InterfaceInfo? localInterface)
    {
        if (localInterface is null || localInterface.IsVirtual) return false;
        try { return VpnProcesses.Contains(Process.GetProcessById(pid).ProcessName); }
        catch { return false; }
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
        session.Dispose();
        session = null;
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
