using System.Net;
using System.Net.Sockets;

namespace EgressView.Agent.Core;

/// One LAN sender reaching this PC's closed ports in one window (P3-191), in
/// the shape the Hub stores and the Mac Agent sends.
public sealed record InboundProbeSummary(DateTimeOffset WindowStart, int WindowSeconds, string LocalAddress,
    string SourceAddress, string NetworkProtocol, int DistinctPorts, int Packets, IReadOnlyList<int> SamplePorts);

/// Counts, per LAN sender and two-minute window, how many of this PC's ports
/// it tried and was turned away from (P3-191).
///
/// The Windows counterpart of the Mac's packet-filter counter, fed by a
/// different source: Microsoft-Windows-TCPIP reports a TCP segment it dropped
/// because nothing listens on the port (TcpipTransportPacketDrops, reason 4),
/// with the sender's address. That is what a probe of a closed port looks
/// like from here; a probe of an open port becomes a connection and is seen
/// with the rest of the traffic. The event carries no TCP flags, so the Mac's
/// "SYN without ACK" test has no equivalent; a stray late segment to a port a
/// connection has just left is told apart by the port instead -- those land
/// on the ephemeral range, which is not counted, as on the Mac. Measured on
/// 2026-10-20: a Mac's `nc -z` to ports 1-30 showed as 30 ports, 60 drops.
///
/// Only addresses and port numbers are kept, never content. TCP only for now:
/// how Windows reports a UDP datagram to a closed port has not been measured.
public sealed class InboundProbeCounter
{
    public const int WindowSeconds = 120;
    /// Reported from this many distinct ports; the Hub notifies from 10.
    public const int ReportMinPorts = 5;
    public const int EphemeralFloor = 49152;
    const int MaxSenders = 4096;
    const int MaxPortsPerSender = 4096;
    const int SampleSize = 10;

    private readonly object gate = new();
    private readonly Dictionary<(long Window, string Local, string Source), (HashSet<int> Ports, int Packets)> tallies = [];
    private long countedPackets, sendersReported;

    public long CountedPackets { get { lock (gate) return countedPackets; } }
    public long SendersReported { get { lock (gate) return sendersReported; } }

    public void Record(string? sourceAddress, string? localAddress, int localPort, DateTimeOffset at)
    {
        if (localPort is <= 0 or >= EphemeralFloor) return;
        if (Normal(sourceAddress) is not { } source || Normal(localAddress) is not { } local || source == local) return;
        if (!IsLanUnicast(source)) return;
        var window = at.ToUnixTimeSeconds() / WindowSeconds * WindowSeconds;
        lock (gate)
        {
            var key = (window, local, source);
            if (!tallies.TryGetValue(key, out var tally))
            {
                if (tallies.Count >= MaxSenders) return;
                tally = ([], 0);
            }
            if (tally.Ports.Count < MaxPortsPerSender) tally.Ports.Add(localPort);
            tallies[key] = (tally.Ports, tally.Packets + 1);
            countedPackets++;
        }
    }

    /// The windows that have ended by `now`, reported and forgotten.
    public IReadOnlyList<InboundProbeSummary> TakeCompleted(DateTimeOffset now)
    {
        var current = now.ToUnixTimeSeconds() / WindowSeconds * WindowSeconds;
        var summaries = new List<InboundProbeSummary>();
        lock (gate)
        {
            foreach (var (key, tally) in tallies.Where(pair => pair.Key.Window < current).ToList())
            {
                tallies.Remove(key);
                if (tally.Ports.Count < ReportMinPorts) continue;
                summaries.Add(new(DateTimeOffset.FromUnixTimeSeconds(key.Window), WindowSeconds, key.Local, key.Source, "tcp",
                    tally.Ports.Count, tally.Packets, [.. tally.Ports.Order().Take(SampleSize)]));
            }
            sendersReported += summaries.Count;
        }
        return [.. summaries.OrderBy(summary => summary.WindowStart).ThenBy(summary => summary.SourceAddress, StringComparer.Ordinal)];
    }

    static string? Normal(string? value)
    {
        if (!IPAddress.TryParse(value, out var address)) return null;
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily == AddressFamily.InterNetworkV6 && address.ScopeId != 0)
            address = new IPAddress(address.GetAddressBytes());
        return address.ToString();
    }

    /// A LAN address that is one device: not this network's broadcast or a
    /// multicast group, which are discovery rather than probing.
    static bool IsLanUnicast(string address) =>
        PrivateAddress.NetworkName(address) == PrivateAddress.Lan
        && IPAddress.TryParse(address, out var parsed)
        && !(parsed.AddressFamily == AddressFamily.InterNetwork && parsed.GetAddressBytes()[3] == 255)
        && !parsed.IsIPv6Multicast;
}

/// Inbound probe summaries waiting to go to the Hub with the next batch.
///
/// Held in memory and bounded: they are a few a day on a quiet network, and a
/// burst that outruns delivery keeps the newest rather than growing without
/// end. Taken for a batch and returned if the batch is not acknowledged, so a
/// failed send does not lose them.
public sealed class InboundProbeOutbox
{
    public const int MaxPerBatch = 50;
    public const int Capacity = 500;

    private readonly object gate = new();
    private readonly List<InboundProbeSummary> waiting = [];
    private long sent, dropped;

    public int Pending { get { lock (gate) return waiting.Count; } }
    public long Sent { get { lock (gate) return sent; } }
    public long Dropped { get { lock (gate) return dropped; } }

    public void Add(IEnumerable<InboundProbeSummary> summaries)
    {
        lock (gate)
        {
            waiting.AddRange(summaries);
            if (waiting.Count > Capacity)
            {
                dropped += waiting.Count - Capacity;
                waiting.RemoveRange(0, waiting.Count - Capacity);
            }
        }
    }

    public IReadOnlyList<InboundProbeSummary> Take()
    {
        lock (gate)
        {
            var taken = waiting.Take(MaxPerBatch).ToList();
            waiting.RemoveRange(0, taken.Count);
            return taken;
        }
    }

    public void MarkSent(IReadOnlyList<InboundProbeSummary> summaries) { lock (gate) sent += summaries.Count; }

    public void Return(IReadOnlyList<InboundProbeSummary> summaries)
    {
        if (summaries.Count == 0) return;
        lock (gate) waiting.InsertRange(0, summaries);
    }
}
