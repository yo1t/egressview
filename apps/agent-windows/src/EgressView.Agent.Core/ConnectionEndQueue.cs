namespace EgressView.Agent.Core;

/// The end of a TCP connection as Windows reported it: the two endpoints as
/// the event named them, which is not always local first.
public sealed record ConnectionEnd(string SourceAddress, int SourcePort, string DestinationAddress, int DestinationPort, DateTimeOffset At);

/// Holds connection ends until the row they close has had time to be written
/// (P3-108).
///
/// The end and the traffic before it take different paths. Traffic is summed
/// for a second, closed a second later, and then queued for the store; the end
/// comes straight from the event. So an end usually arrives before the row it
/// closes exists. Ends wait here a few seconds, are tried, and those that still
/// find no row are tried again until a minute has passed -- traffic held back
/// for its process name can take that long. Past that, the end is dropped and
/// counted: the row then simply has no end, which is what the log already says
/// for the 0.2% of connections whose end Windows never reports.
public sealed class ConnectionEndQueue
{
    /// How long an end waits before it is first tried.
    public static readonly TimeSpan Settle = TimeSpan.FromSeconds(3);
    /// How long an end keeps being tried.
    public static readonly TimeSpan GiveUp = TimeSpan.FromMinutes(1);
    /// A bound on what waits. Ends arrive at about three a second on a busy
    /// desktop and are applied every five seconds, so this is reached only if
    /// the store stops taking them, and then new ends are counted, not held.
    public const int Capacity = 50_000;

    private readonly object gate = new();
    private readonly List<ConnectionEnd> waiting = [];
    private long recorded, dropped, overflow;

    public long Recorded { get { lock (gate) return recorded; } }
    public long Dropped { get { lock (gate) return dropped; } }
    public long Overflow { get { lock (gate) return overflow; } }
    public int Waiting { get { lock (gate) return waiting.Count; } }

    public void Add(ConnectionEnd end)
    {
        lock (gate)
        {
            if (waiting.Count >= Capacity) { overflow++; return; }
            waiting.Add(end);
        }
    }

    /// Applies the ends that have settled, with whatever writes them, and
    /// keeps the ones that found no row for another try.
    public void Apply(Func<IReadOnlyList<ConnectionEnd>, IReadOnlyList<ConnectionEnd>> record, DateTimeOffset now)
    {
        List<ConnectionEnd> due;
        lock (gate)
        {
            due = waiting.Where(end => now - end.At >= Settle).ToList();
            if (due.Count == 0) return;
            waiting.RemoveAll(end => now - end.At >= Settle);
        }
        IReadOnlyList<ConnectionEnd> unmatched;
        try { unmatched = record(due); }
        catch
        {
            // Not lost to a failed write: they go back and are tried again.
            unmatched = due;
        }
        lock (gate)
        {
            recorded += due.Count - unmatched.Count;
            foreach (var end in unmatched)
            {
                if (now - end.At >= GiveUp) dropped++;
                else if (waiting.Count < Capacity) waiting.Add(end);
                else overflow++;
            }
        }
    }
}
