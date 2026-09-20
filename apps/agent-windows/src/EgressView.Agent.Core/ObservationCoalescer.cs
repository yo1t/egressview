namespace EgressView.Agent.Core;

/// Sums one flow's events within one second into a single observation.
///
/// The collector wrote a row per ETW event, and an ETW network event is a
/// packet. Measured on one machine, a single chrome connection to a CDN
/// produced 132,928 rows in 1.4 seconds, against a store that absorbs about a
/// hundred rows a second. The consequences were not a slow screen: the session
/// buffers filled, 7,119,190 events were lost, and what did get through was
/// written so far behind the clock that the Agent displayed traffic from
/// thirty-eight minutes earlier while reporting itself as running. Event time
/// advanced at one part in a thousand of real time, so it was never going to
/// catch up.
///
/// Nothing above this needs a row per packet. What the product answers -- what
/// talked to whom, how much moved -- is the sum. Summing it here bounds the
/// write rate by the number of active flows instead of the link speed, which
/// is the only one of the two that a machine's own activity limits.
///
/// Not thread-safe, and does not need to be: it is driven from the single ETW
/// callback thread, and drained after that thread has been awaited, which is
/// the arrangement the deferred-name buffer beside it already relies on.
internal sealed class ObservationCoalescer
{
    /// The window whose events are summed into one row.
    ///
    /// A second is short enough that no chart in the product can tell the
    /// difference -- the finest bucket a period can be drawn in is far wider --
    /// and long enough to fold a saturated connection's tens of thousands of
    /// packets into one write.
    public static readonly TimeSpan BucketDuration = TimeSpan.FromSeconds(1);

    /// How far past a bucket's end the event timeline must move before that
    /// bucket is closed.
    ///
    /// ETW callbacks are not strictly ordered, and a bucket closed the instant
    /// the next second began would split late arrivals into a second row. This
    /// is the tolerance for that, not a delay budget: it costs one second of
    /// latency on an idle flow and nothing on a busy one.
    public static readonly TimeSpan CloseGrace = TimeSpan.FromSeconds(1);

    /// The ceiling on flows held open at once.
    ///
    /// A bound that is reached is a bound that has to do something sensible,
    /// so reaching it emits what is held rather than dropping it. Ten thousand
    /// simultaneous flows on one machine is already far outside what has been
    /// observed; a port scan is the shape that would do it, and a port scan is
    /// exactly what must not be silently discarded.
    public const int MaximumOpenFlows = 10_000;

    private readonly Dictionary<Key, Entry> open = new();
    private DateTimeOffset timeline;
    private long folded;
    private long emitted;
    private long overflows;

    /// Events merged into a row that already existed. The compression this
    /// achieves is Folded against Emitted, and it is the number that says
    /// whether the store is being asked for something it can do.
    public long Folded => folded;
    public long Emitted => emitted;
    public long Overflows => overflows;
    public int OpenFlows => open.Count;

    /// Takes one event and returns the rows that are now final.
    public IEnumerable<NetworkObservation> Add(NetworkObservation observation)
    {
        if (observation.ObservedAt > timeline) timeline = observation.ObservedAt;
        var key = KeyOf(observation);
        if (open.TryGetValue(key, out var entry))
        {
            entry.Add(observation);
            folded++;
        }
        else
        {
            open[key] = new Entry(observation);
        }

        if (open.Count > MaximumOpenFlows)
        {
            overflows++;
            return Drain();
        }
        return Expire(timeline);
    }

    /// Closes every bucket the timeline has moved past.
    public IEnumerable<NetworkObservation> Expire(DateTimeOffset now)
    {
        if (now > timeline) timeline = now;
        List<Key>? due = null;
        foreach (var (key, entry) in open)
        {
            if (key.BucketStart + BucketDuration + CloseGrace > timeline) continue;
            (due ??= []).Add(key);
        }
        if (due is null) return [];
        var ready = new List<NetworkObservation>(due.Count);
        foreach (var key in due)
        {
            ready.Add(open[key].ToObservation());
            open.Remove(key);
        }
        emitted += ready.Count;
        return ready;
    }

    /// Closes everything held, for a stop or an overflow.
    public IEnumerable<NetworkObservation> Drain()
    {
        if (open.Count == 0) return [];
        var ready = new List<NetworkObservation>(open.Count);
        foreach (var entry in open.Values) ready.Add(entry.ToObservation());
        open.Clear();
        emitted += ready.Count;
        return ready;
    }

    private static Key KeyOf(NetworkObservation observation) => new(
        Truncate(observation.ObservedAt), observation.ProcessId, observation.Protocol,
        observation.LocalAddress, observation.LocalPort, observation.RemoteAddress, observation.RemotePort,
        observation.Layer, observation.InterfaceId, observation.Source,
        observation.ProcessName, observation.RemoteHostname);

    internal static DateTimeOffset Truncate(DateTimeOffset value) =>
        new(value.UtcTicks - value.UtcTicks % BucketDuration.Ticks, TimeSpan.Zero);

    private sealed record Key(
        DateTimeOffset BucketStart, int ProcessId, string Protocol,
        string LocalAddress, int LocalPort, string RemoteAddress, int RemotePort,
        ObservationLayer Layer, string? InterfaceId, string Source,
        string? ProcessName, string? RemoteHostname);

    /// One flow's running total within one bucket.
    ///
    /// Sent and received are kept null until something is known, so a flow
    /// whose bytes were never reported still reads as unmeasured rather than
    /// as zero: the store and the screen both distinguish the two, and folding
    /// must not turn "we do not know" into "none".
    private sealed class Entry(NetworkObservation first)
    {
        private readonly NetworkObservation template = first;
        private DateTimeOffset earliest = first.ObservedAt;
        private long? sent = first.BytesSent;
        private long? received = first.BytesReceived;

        public void Add(NetworkObservation observation)
        {
            if (observation.ObservedAt < earliest) earliest = observation.ObservedAt;
            sent = Sum(sent, observation.BytesSent);
            received = Sum(received, observation.BytesReceived);
        }

        public NetworkObservation ToObservation() =>
            template with { ObservedAt = earliest, BytesSent = sent, BytesReceived = received };

        private static long? Sum(long? current, long? addition) =>
            current is null ? addition : addition is null ? current : current + addition;
    }
}
