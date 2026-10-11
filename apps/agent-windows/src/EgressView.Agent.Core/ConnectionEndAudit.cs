using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;

namespace EgressView.Agent.Core;

/// Whether Windows reports the end of every TCP connection it reported the
/// start of (P3-108).
///
/// The per-kind counters could only say that, in total, about as many
/// disconnects arrived as connections opened. That hides a share of ends that
/// never arrive behind ends of connections opened before the Agent started,
/// and on the Mac about one end in ten never arrives. So each connection is
/// followed from its start to its end. One that has left the system's own
/// TCP table without an end ever arriving is a missed end, and that count is
/// the measurement.
///
/// Measurement only: nothing is stored and nothing on screen depends on it.
/// Loopback is left out because it is most of the volume and none of what
/// the Agent shows.
public sealed class ConnectionEndAudit
{
    /// Enough for a busy desktop; past it, new starts are counted, not followed.
    public const int Capacity = 20_000;

    /// How long a start is left before its absence from the table counts.
    /// The table is read on the service's clock and events arrive a little
    /// behind it, so a connection that closed a moment ago may not have had
    /// its end processed yet.
    public static readonly TimeSpan Grace = TimeSpan.FromSeconds(30);

    private readonly object gate = new();
    private readonly Dictionary<string, DateTimeOffset> open = new(StringComparer.Ordinal);
    private long opened, endedMatched, endedWithoutStart, missedEnds, overflow, reconciliations;

    public long Opened { get { lock (gate) return opened; } }
    public long EndedMatched { get { lock (gate) return endedMatched; } }
    /// Ends of connections whose start was not seen: opened before the Agent
    /// started, or while the table of followed connections was full.
    public long EndedWithoutStart { get { lock (gate) return endedWithoutStart; } }
    public long MissedEnds { get { lock (gate) return missedEnds; } }
    public long Overflow { get { lock (gate) return overflow; } }
    public long Reconciliations { get { lock (gate) return reconciliations; } }
    public int StillOpen { get { lock (gate) return open.Count; } }

    public void Started(string? localAddress, int localPort, string? remoteAddress, int remotePort, DateTimeOffset at)
    {
        if (Key(localAddress, localPort, remoteAddress, remotePort) is not { } key) return;
        lock (gate)
        {
            if (open.ContainsKey(key)) return;
            if (open.Count >= Capacity) { overflow++; return; }
            open[key] = at;
            opened++;
        }
    }

    public void Ended(string? localAddress, int localPort, string? remoteAddress, int remotePort)
    {
        if (Key(localAddress, localPort, remoteAddress, remotePort) is not { } key) return;
        lock (gate)
        {
            if (open.Remove(key)) endedMatched++;
            else endedWithoutStart++;
        }
    }

    /// Counts as missed every followed connection older than the grace period
    /// that is no longer in the system's TCP table.
    public void Reconcile(IEnumerable<(IPEndPoint Local, IPEndPoint Remote)> table, DateTimeOffset now)
    {
        var present = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (local, remote) in table)
            if (Key(local.Address.ToString(), local.Port, remote.Address.ToString(), remote.Port) is { } key) present.Add(key);
        lock (gate)
        {
            reconciliations++;
            foreach (var (key, startedAt) in open.ToArray())
            {
                if (now - startedAt < Grace || present.Contains(key)) continue;
                open.Remove(key);
                missedEnds++;
            }
        }
    }

    public static IEnumerable<(IPEndPoint Local, IPEndPoint Remote)> SystemTable() =>
        IPGlobalProperties.GetIPGlobalProperties().GetActiveTcpConnections().Select(c => (c.LocalEndPoint, c.RemoteEndPoint));

    /// The same string for both directions of one connection, whichever end
    /// the event named as the source.
    public static string? Key(string? localAddress, int localPort, string? remoteAddress, int remotePort)
    {
        if (Normal(localAddress) is not { } local || Normal(remoteAddress) is not { } remote) return null;
        if (IPAddress.IsLoopback(local) || IPAddress.IsLoopback(remote)) return null;
        var a = $"{local}|{localPort}";
        var b = $"{remote}|{remotePort}";
        return string.CompareOrdinal(a, b) <= 0 ? $"{a}>{b}" : $"{b}>{a}";
    }

    private static IPAddress? Normal(string? value)
    {
        if (!IPAddress.TryParse(value, out var address)) return null;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.ScopeId != 0)
            address = new IPAddress(address.GetAddressBytes());
        return address;
    }
}
