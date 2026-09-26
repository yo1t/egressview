namespace EgressView.Agent.Core;

/// How long the window waits before refreshing the tab it shows again.
///
/// Every five seconds, whatever the period, was what the network tab did. Its
/// refresh re-aggregates the whole period in the service, and what that costs
/// grows with the period: measured on one machine (2026-09-26, 1.0 million
/// flows), 0.25 s of service CPU for the last hour, 0.71 s for six hours,
/// 2.5 s for a day, 8.7 s for seven days and 13 s for thirty. Six hours every
/// five seconds was the fifth of a core seen with the tab open; seven days
/// could not finish in five seconds, so the service aggregated without pause
/// for as long as the tab was on screen -- to redraw a week that five seconds
/// could not visibly change.
///
/// So the wait follows what the last refresh took rather than which period is
/// chosen: twenty times as long, which holds the refreshes to a twentieth of
/// the time on any machine and any history. The last hour still refreshes
/// every five seconds; a week, every few minutes. Choosing a period, switching
/// tabs and the refresh button do not wait.
public static class RefreshPacing
{
    public static readonly TimeSpan Shortest = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan Longest = TimeSpan.FromMinutes(10);
    public const int WaitPerRefreshTime = 20;

    public static TimeSpan After(TimeSpan lastRefreshTook)
    {
        var wait = lastRefreshTook * WaitPerRefreshTime;
        return wait < Shortest ? Shortest : wait > Longest ? Longest : wait;
    }
}
