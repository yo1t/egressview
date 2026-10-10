using System.Diagnostics;

namespace EgressView.Agent.Core;

/// How far the times ETW stamps on events have fallen behind the wall clock,
/// and the correction for it (P3-188).
///
/// TraceEvent turns an event's high-resolution counter into a time from the
/// wall clock read once, when the session started, plus the counter's
/// progress since. On a virtual machine the counter does not advance while
/// the machine is paused, and Windows sets the wall clock forward when it
/// resumes. Every event after that was stamped exactly as long before it
/// happened as the machine had been paused: on 2026-10-09 a VM's observations
/// arrived at the Hub 27.5 minutes old, steadily, from the moment it resumed,
/// and stayed so until the session was made again.
///
/// The drift is measured from the clocks themselves -- the wall clock now
/// against the wall clock at the start plus the counter's progress -- not
/// from how late events arrive, so a backlog in processing is never mistaken
/// for it.
public sealed class EventClockDrift(Func<DateTimeOffset>? wall = null, Func<long>? counter = null, long? frequency = null)
{
    /// Below this the two clocks are treated as agreeing. Time synchronisation
    /// slews a real machine's clock by fractions of a second, and correcting
    /// for that would move every observation by an amount nobody can see.
    public static readonly TimeSpan Threshold = TimeSpan.FromSeconds(1);

    private readonly Func<DateTimeOffset> wall = wall ?? (() => DateTimeOffset.UtcNow);
    private readonly Func<long> counter = counter ?? Stopwatch.GetTimestamp;
    private readonly long frequency = frequency ?? Stopwatch.Frequency;
    private long anchorWallTicks;
    private long anchorCounter;

    /// Called when the session starts, as TraceEvent reads its own clocks.
    public void Anchor()
    {
        Interlocked.Exchange(ref anchorWallTicks, wall().UtcTicks);
        Interlocked.Exchange(ref anchorCounter, counter());
    }

    /// The wall clock minus the time the counter says it is. Positive when
    /// event times are behind.
    public TimeSpan Drift
    {
        get
        {
            var anchorTicks = Interlocked.Read(ref anchorWallTicks);
            if (anchorTicks == 0) return TimeSpan.Zero;
            var elapsed = TimeSpan.FromSeconds((double)(counter() - Interlocked.Read(ref anchorCounter)) / frequency);
            return wall() - (new DateTimeOffset(anchorTicks, TimeSpan.Zero) + elapsed);
        }
    }

    /// The event's time as the wall clock would have read it.
    public DateTimeOffset Correct(DateTimeOffset eventTime)
    {
        var drift = Drift;
        return drift.Duration() >= Threshold ? eventTime + drift : eventTime;
    }
}
