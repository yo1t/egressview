namespace EgressView.Agent.Core;

/// Holds only observations whose process start was seen but whose name could
/// not be queried before the process exited. ProcessStop carries ImageName,
/// so a short bounded wait can recover the real name without guessing.
public sealed class DeferredProcessObservations
{
    private readonly TimeSpan retention;
    private readonly int capacity;
    private readonly List<Entry> entries = [];
    private long deferred, recovered, expired, overflow;

    private sealed record Entry(NetworkObservation Observation, DateTimeOffset ProcessStartedAt,
        DateTimeOffset DeferredAt);

    public DeferredProcessObservations(TimeSpan? retention = null, int capacity = 4096)
    {
        this.retention = retention ?? TimeSpan.FromSeconds(10);
        if (this.retention <= TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(retention));
        if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
        this.capacity = capacity;
    }

    public int Pending => entries.Count;
    public long Deferred => Interlocked.Read(ref deferred);
    public long Recovered => Interlocked.Read(ref recovered);
    public long Expired => Interlocked.Read(ref expired);
    public long Overflow => Interlocked.Read(ref overflow);

    public bool TryDefer(NetworkObservation observation, DateTimeOffset processStartedAt,
        DateTimeOffset deferredAt)
    {
        if (entries.Count >= capacity)
        {
            Interlocked.Increment(ref overflow);
            return false;
        }
        entries.Add(new Entry(observation, processStartedAt, deferredAt));
        Interlocked.Increment(ref deferred);
        return true;
    }

    public IReadOnlyList<NetworkObservation> Complete(int processId, DateTimeOffset processStartedAt,
        string processName)
    {
        var completed = RemoveWhere(entry => entry.Observation.ProcessId == processId
            && entry.ProcessStartedAt == processStartedAt);
        if (completed.Count == 0) return [];
        Interlocked.Add(ref recovered, completed.Count);
        return completed.Select(entry => entry.Observation with { ProcessName = processName }).ToArray();
    }

    public IReadOnlyList<NetworkObservation> Expire(DateTimeOffset now)
    {
        var stale = RemoveWhere(entry => now - entry.DeferredAt >= retention);
        if (stale.Count == 0) return [];
        Interlocked.Add(ref expired, stale.Count);
        return stale.Select(entry => entry.Observation).ToArray();
    }

    public IReadOnlyList<NetworkObservation> Drain()
    {
        if (entries.Count == 0) return [];
        var remaining = entries.Select(entry => entry.Observation).ToArray();
        entries.Clear();
        Interlocked.Add(ref expired, remaining.Length);
        return remaining;
    }

    private List<Entry> RemoveWhere(Func<Entry, bool> predicate)
    {
        var removed = new List<Entry>();
        for (var index = entries.Count - 1; index >= 0; index--)
        {
            if (!predicate(entries[index])) continue;
            removed.Add(entries[index]);
            entries.RemoveAt(index);
        }
        removed.Reverse();
        return removed;
    }
}
