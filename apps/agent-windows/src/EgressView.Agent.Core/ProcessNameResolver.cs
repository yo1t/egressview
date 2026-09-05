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
    private readonly ConcurrentDictionary<int, byte> processesPresentAtStartup;
    private readonly ConcurrentDictionary<int, DateTimeOffset> startEventsWithoutName = new();
    private readonly TimeSpan retention;
    private readonly Func<int, LiveProcess?> probe;

    private long cacheHits, liveLookups, expired, pidReuseRejected, observedStarts, neverSeen;
    private long neverSeenAtStartup, neverSeenAfterStartup, invalidProcessId;
    private long neverSeenAfterStartProbeMiss, neverSeenWithoutStartEvent;

    public ProcessNameResolver() : this(DefaultRetention, ProbeLiveProcess, SnapshotProcessIds()) { }

    /// The probe is injectable so the reuse and expiry rules can be tested
    /// without waiting for real processes to start and exit.
    public ProcessNameResolver(TimeSpan retention, Func<int, LiveProcess?> probe, IEnumerable<int>? startupProcessIds = null)
    {
        this.retention = retention;
        this.probe = probe;
        processesPresentAtStartup = new ConcurrentDictionary<int, byte>(
            (startupProcessIds ?? []).Where(pid => pid > 0).Select(pid => new KeyValuePair<int, byte>(pid, 0)));
    }

    /// A process as it exists right now. StartedAt is absent when the process
    /// is visible but its start time is not readable.
    public readonly record struct LiveProcess(string Name, DateTimeOffset? StartedAt);

    private sealed record Entry(string Name, DateTimeOffset? StartedAt, DateTimeOffset LastSeenAlive);

    public long CacheHits => Interlocked.Read(ref cacheHits);
    public long LiveLookups => Interlocked.Read(ref liveLookups);
    public long Expired => Interlocked.Read(ref expired);
    public long PidReuseRejected => Interlocked.Read(ref pidReuseRejected);
    /// Names learned from process start events rather than by querying.
    public long ObservedStarts => Interlocked.Read(ref observedStarts);
    /// Observations for a PID this resolver never saw alive and never
    /// received a start event for. Nothing can name these: the process was
    /// already running when collection began, or its start was missed.
    public long NeverSeen => Interlocked.Read(ref neverSeen);
    /// Nameless observations whose PID existed when this resolver started.
    /// These identify the startup-snapshot gap without exposing the PID.
    public long NeverSeenAtStartup => Interlocked.Read(ref neverSeenAtStartup);
    /// Nameless observations whose PID was absent at startup. These point to
    /// a missed lifecycle event or a process that exited before probing.
    public long NeverSeenAfterStartup => Interlocked.Read(ref neverSeenAfterStartup);
    /// Nameless post-startup observations for a PID whose start event arrived,
    /// but whose process had already disappeared when it was queried.
    public long NeverSeenAfterStartProbeMiss => Interlocked.Read(ref neverSeenAfterStartProbeMiss);
    /// Nameless post-startup observations with no lifecycle start observed.
    public long NeverSeenWithoutStartEvent => Interlocked.Read(ref neverSeenWithoutStartEvent);
    /// Observations carrying PID zero or another unusable process identifier.
    public long InvalidProcessId => Interlocked.Read(ref invalidProcessId);
    public int Cached => cache.Count;

    public bool TryGetUnresolvedStart(int processId, out DateTimeOffset startedAt) =>
        startEventsWithoutName.TryGetValue(processId, out startedAt);

    /// <param name="observedAt">
    /// When the observation happened, not when it is being processed. Events
    /// reach here through a channel, so wall-clock time would judge staleness
    /// against the wrong moment.
    /// </param>
    public string? Resolve(int processId, DateTimeOffset observedAt)
    {
        if (processId <= 0)
        {
            Interlocked.Increment(ref invalidProcessId);
            return null;
        }

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
        if (!cache.TryGetValue(processId, out var entry))
        {
            // Never seen alive and no start event for it. Distinguishing this
            // from an expired entry is what separates "started before we did"
            // from "we forgot", and those need different fixes.
            Interlocked.Increment(ref neverSeen);
            if (processesPresentAtStartup.ContainsKey(processId))
                Interlocked.Increment(ref neverSeenAtStartup);
            else
            {
                Interlocked.Increment(ref neverSeenAfterStartup);
                if (startEventsWithoutName.ContainsKey(processId))
                    Interlocked.Increment(ref neverSeenAfterStartProbeMiss);
                else
                    Interlocked.Increment(ref neverSeenWithoutStartEvent);
            }
            return null;
        }

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

    /// Record a process the moment it starts, before any of its traffic is
    /// seen.
    ///
    /// Querying at event time cannot help a process that is already gone by
    /// the time its first event is processed, and those are exactly the
    /// short-lived processes worth naming. Learning the name from the process
    /// start event removes the race instead of narrowing it.
    ///
    /// The image name arrives as a path; it is reduced to the bare name so it
    /// matches what Process.ProcessName produces. Two spellings of the same
    /// program would split its traffic in the Hub's per-application view.
    public string? Observe(int processId, string? imageName, DateTimeOffset startedAt)
    {
        if (processId <= 0) return null;
        processesPresentAtStartup.TryRemove(processId, out _);
        var name = Sanitize(BareName(imageName));
        if (name is null) return null;
        startEventsWithoutName.TryRemove(processId, out _);
        Interlocked.Increment(ref observedStarts);
        Remember(processId, new Entry(name, startedAt, Later(startedAt)));
        return name;
    }

    /// Learn the name of a process that has just started.
    ///
    /// The provider's ProcessStart event carries the PID and the create time
    /// but **not** the image name -- that field is only on ProcessStop, which
    /// is too late for the traffic in between. At the instant of the start
    /// event the process is certainly alive, so querying it there is what
    /// removes the race: by the time its first network event is processed it
    /// may already be gone.
    public void Learn(int processId, DateTimeOffset startedAt)
    {
        if (processId <= 0) return;
        // Seeing a start proves this use of the PID is not the process that
        // was present in the initial snapshot, even if it exits before the
        // live-process query completes.
        processesPresentAtStartup.TryRemove(processId, out _);
        if (SafeProbe(processId) is not { } running)
        {
            startEventsWithoutName[processId] = startedAt;
            return;
        }
        var name = Sanitize(running.Name);
        if (name is null)
        {
            startEventsWithoutName[processId] = startedAt;
            return;
        }
        startEventsWithoutName.TryRemove(processId, out _);
        Interlocked.Increment(ref observedStarts);
        Remember(processId, new Entry(name, running.StartedAt ?? startedAt, Later(startedAt)));
    }

    internal static string? BareName(string? imageName)
    {
        if (string.IsNullOrWhiteSpace(imageName)) return null;
        var trimmed = imageName.Trim();
        var separator = trimmed.LastIndexOfAny(['\\', '/']);
        if (separator >= 0) trimmed = trimmed[(separator + 1)..];
        var dot = trimmed.LastIndexOf('.');
        if (dot > 0) trimmed = trimmed[..dot];
        return trimmed.Length == 0 ? null : trimmed;
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

    private static IEnumerable<int> SnapshotProcessIds()
    {
        try
        {
            return Process.GetProcesses().Select(process =>
            {
                try { return process.Id; }
                finally { process.Dispose(); }
            }).ToArray();
        }
        catch (Exception) { return []; }
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
