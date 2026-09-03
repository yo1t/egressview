using System.Collections.Concurrent;
using System.Diagnostics;

namespace EgressView.Agent.Core;

/// Resolves a PID to a process name, and remembers the answer.
///
/// The uncached form loses the name the moment the process exits, and it
/// loses it for every later observation of the same flow -- not just the last
/// one. Half of this machine's flows arrived without a name for that reason,
/// and an observation without a name is dropped before delivery because the
/// Hub requires one. The Agent exists to replace the Hub's guessing with the
/// real name, so a flow that arrives nameless puts the Hub back to guessing.
///
/// Caching a PID is only safe with something that distinguishes one use of
/// that number from the next. Windows reuses PIDs, so an entry carries the
/// process start time and is refused for observations that predate it.
public sealed class ProcessNameResolver
{
    /// How long a name outlives the process it belongs to.
    ///
    /// Long enough to cover the events still in flight through the channel
    /// when a short-lived process exits, short enough that a PID handed to a
    /// different process later is unlikely to be answered from this entry. A
    /// wrong name is worse than no name: no name is visibly missing, while a
    /// wrong one is indistinguishable from a correct one.
    private static readonly TimeSpan DefaultRetention = TimeSpan.FromMinutes(2);

    /// Bounded so a machine that churns through PIDs cannot grow this without
    /// limit. Eviction drops the least recently confirmed entries.
    private const int MaxEntries = 8192;

    private readonly ConcurrentDictionary<int, Entry> cache = new();
    private readonly TimeSpan retention;
    private readonly Func<int, LiveProcess?> probe;

    private long cacheHits, liveLookups, expired, pidReuseRejected;

    public ProcessNameResolver() : this(DefaultRetention, ProbeLiveProcess) { }

    /// The probe is injectable so the reuse and expiry rules can be tested
    /// without waiting for real processes to start and exit.
    public ProcessNameResolver(TimeSpan retention, Func<int, LiveProcess?> probe)
    {
        this.retention = retention;
        this.probe = probe;
    }

    /// A process as it exists right now. StartedAt is absent when the process
    /// is visible but its start time is not readable.
    public readonly record struct LiveProcess(string Name, DateTimeOffset? StartedAt);

    private sealed record Entry(string Name, DateTimeOffset? StartedAt, DateTimeOffset LastSeenAlive);

    public long CacheHits => Interlocked.Read(ref cacheHits);
    public long LiveLookups => Interlocked.Read(ref liveLookups);
    public long Expired => Interlocked.Read(ref expired);
    public long PidReuseRejected => Interlocked.Read(ref pidReuseRejected);
    public int Cached => cache.Count;

    /// <param name="observedAt">
    /// When the observation happened, not when it is being processed. Events
    /// reach here through a channel, so wall-clock time would judge staleness
    /// against the wrong moment.
    /// </param>
    public string? Resolve(int processId, DateTimeOffset observedAt)
    {
        if (processId <= 0) return null;

        var live = SafeProbe(processId);
        if (live is { } running)
        {
            Interlocked.Increment(ref liveLookups);
            var name = Sanitize(running.Name);
            if (name is null) return null;
            Remember(processId, new Entry(name, running.StartedAt, Later(observedAt)));
            return name;
        }

        // The process is gone. Its name is still the right answer for the
        // events it produced while it was alive.
        if (!cache.TryGetValue(processId, out var entry)) return null;

        if (entry.StartedAt is { } startedAt && observedAt < startedAt)
        {
            // This observation predates the process we cached, so it belongs
            // to whatever held the PID before it.
            Interlocked.Increment(ref pidReuseRejected);
            return null;
        }

        if (observedAt - entry.LastSeenAlive > retention)
        {
            Interlocked.Increment(ref expired);
            cache.TryRemove(processId, out _);
            return null;
        }

        Interlocked.Increment(ref cacheHits);
        return entry.Name;
    }

    private void Remember(int processId, Entry entry)
    {
        cache.AddOrUpdate(processId, entry, (_, existing) =>
        {
            // A different start time on the same PID means the number was
            // handed to a new process; the old name must not survive it.
            if (existing.StartedAt is { } previous && entry.StartedAt is { } current && previous != current)
            {
                Interlocked.Increment(ref pidReuseRejected);
                return entry;
            }
            return entry with { LastSeenAlive = Later(entry.LastSeenAlive, existing.LastSeenAlive) };
        });

        if (cache.Count > MaxEntries) Evict();
    }

    private void Evict()
    {
        foreach (var stale in cache.OrderBy(pair => pair.Value.LastSeenAlive).Take(cache.Count - (MaxEntries / 2)))
            cache.TryRemove(stale.Key, out _);
    }

    private LiveProcess? SafeProbe(int processId)
    {
        try { return probe(processId); }
        catch (Exception) { return null; }
    }

    private static LiveProcess? ProbeLiveProcess(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            DateTimeOffset? startedAt = null;
            // StartTime is denied for some processes even when the name is
            // readable. Losing it costs the reuse guard for that PID, not the
            // name, so it is not treated as a failure.
            try { startedAt = process.StartTime.ToUniversalTime(); } catch (Exception) { }
            return new LiveProcess(process.ProcessName, startedAt);
        }
        catch (Exception) { return null; }
    }

    private static string? Sanitize(string? name) =>
        string.IsNullOrWhiteSpace(name) || name.Length > 256 || name.Any(char.IsControl) ? null : name;

    private static DateTimeOffset Later(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;

    /// An observation timestamped in the past still confirms the process was
    /// alive now, so the later of the two is what the retention window runs
    /// from.
    private static DateTimeOffset Later(DateTimeOffset observedAt) =>
        Later(observedAt, DateTimeOffset.UtcNow);
}
