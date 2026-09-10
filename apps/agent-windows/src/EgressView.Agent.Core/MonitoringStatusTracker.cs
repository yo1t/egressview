namespace EgressView.Agent.Core;

public enum MonitoringPresentationKind
{
    Checking,
    Monitoring,
    Stopped,
    NeedsAttention,
    Unavailable,
}

public sealed record MonitoringStatusSnapshot(
    MonitoringPresentationKind Kind,
    DateTimeOffset? LastConfirmedAt = null,
    bool? LastConfirmedEnabled = null,
    bool? LastConfirmedHealthy = null,
    string? IssueCode = null,
    string? IssueAction = null);

public sealed class MonitoringStatusTracker
{
    public MonitoringStatusSnapshot Current { get; private set; } = new(MonitoringPresentationKind.Checking);

    public MonitoringStatusSnapshot Confirm(bool enabled, bool healthy, DateTimeOffset confirmedAt,
        string? issueCode = null, string? issueAction = null)
    {
        var kind = !enabled ? MonitoringPresentationKind.Stopped : healthy
            ? MonitoringPresentationKind.Monitoring
            : MonitoringPresentationKind.NeedsAttention;
        return Current = new(kind, confirmedAt, enabled, healthy, issueCode, issueAction);
    }

    public MonitoringStatusSnapshot MarkUnavailable()
    {
        return Current = Current with { Kind = MonitoringPresentationKind.Unavailable };
    }
}
