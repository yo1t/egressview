namespace EgressView.Agent.Core;

/// One notice's worth of new threat matches: how many destinations, and the
/// matches kept for the history.
public sealed record ThreatNotice(IReadOnlySet<string> Addresses, IReadOnlyList<ThreatFinding> Kept, int More);

/// Decides when a threat match is worth interrupting someone for.
///
/// Ported from the Mac Agent's notification coordinator so the two platforms
/// agree about what reaches a person (P3-180):
///
/// - High confidence only (P3-19). URLhaus lists where malware was served
///   from, so a match on a file-sharing host says a file sat there, not that
///   the destination is hostile. Low-confidence matches stay in the Threats
///   tab; they do not interrupt anyone.
/// - Seen since the last scan, so opening the Agent does not replay the week.
/// - One notice per destination per day, remembered only once it was shown:
///   a notice the daily limit refused is tried again at the next scan.
/// - Not while delivery to the Hub is healthy. The Hub matches the same
///   destinations and notifies about them, and hearing it twice teaches
///   people to ignore both.
public sealed class ThreatNotificationPlanner
{
    /// Matches kept with one notice; the rest are counted.
    public const int DetailLimit = 10;
    public static readonly TimeSpan RepeatAfter = TimeSpan.FromDays(1);

    private readonly Dictionary<string, DateTimeOffset> seen = new(StringComparer.OrdinalIgnoreCase);

    public ThreatNotice? Plan(ThreatReport report, DateTimeOffset since, DateTimeOffset now, bool hubDeliveryHealthy)
    {
        foreach (var stale in seen.Where(item => now - item.Value >= RepeatAfter).Select(item => item.Key).ToArray())
            seen.Remove(stale);
        if (hubDeliveryHealthy || report.Availability != "available") return null;
        var addresses = report.Findings
            .Where(finding => finding.Confidence == "high" && finding.LastSeen >= since && !seen.ContainsKey(finding.Address))
            .Select(finding => finding.Address)
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        if (addresses.Count == 0) return null;
        // Newest first, as the Threats tab would show them the moment the
        // notice arrived.
        var matched = report.Findings.Where(finding => addresses.Contains(finding.Address))
            .OrderByDescending(finding => finding.LastSeen).ToArray();
        var kept = matched.Take(DetailLimit).ToArray();
        return new(addresses, kept, matched.Length - kept.Length);
    }

    /// Called once the notice was shown, so a refused one is tried again.
    public void Accept(ThreatNotice notice, DateTimeOffset now)
    {
        foreach (var address in notice.Addresses) seen[address] = now;
    }

    /// Whether delivery to the Hub is working well enough that the Hub, not
    /// this PC, is the one to say so. The same line the outage notice draws.
    public static bool HubDeliveryHealthy(DeliveryNotificationSample sample) =>
        sample.Active && !DeliveryNotificationTracker.IsFailure(sample.State) &&
        (sample.OldestPendingAt is not { } oldest || sample.ObservedAt - oldest < DeliveryNotificationTracker.OutageGrace);
}
