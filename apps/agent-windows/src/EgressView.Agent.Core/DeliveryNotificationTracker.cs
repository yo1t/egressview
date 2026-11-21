namespace EgressView.Agent.Core;

public enum DeliveryNotificationAction { None, Outage, Recovery }

public sealed record DeliveryNotificationSample(DateTimeOffset ObservedAt, bool Active, string State, long Pending,
    DateTimeOffset? OldestPendingAt, DateTimeOffset? LastAcknowledgedAt);

public sealed record DeliveryNotificationState(DateTimeOffset? FailureStartedAt = null,
    DateTimeOffset? LastOutageAttemptAt = null, DateTimeOffset? LastRecoveryAttemptAt = null, bool OutageWasDelivered = false,
    DateTimeOffset? AcknowledgedAtOutage = null);

public sealed class DeliveryNotificationTracker(DeliveryNotificationState? restored = null)
{
    /// How long a backlog has to sit before this counts as delivery being
    /// stuck rather than delivery being between attempts.
    ///
    /// Public because the window uses the same number. The Agent decided four
    /// times in one soak that delivery had stopped, and said nothing each
    /// time -- HubDelivery notifications are the one category that is off by
    /// default -- so the screen shows it instead. A screen that draws its own
    /// line would be a second opinion about the same fact.
    public static readonly TimeSpan OutageGrace = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RetryInterval = TimeSpan.FromHours(1);
    private DeliveryNotificationState state = restored ?? new();

    public DeliveryNotificationState State => state;

    public DeliveryNotificationAction Evaluate(DeliveryNotificationSample sample)
    {
        if (!sample.Active)
        {
            state = state with { FailureStartedAt = null };
            return DeliveryNotificationAction.None;
        }

        var immediate = sample.State is "authorization-required" or "contract-rejected" or
            "invalid-acknowledgement" or "hub-incompatible";
        if (IsFailure(sample.State) && sample.Pending > 0 && (immediate || !IsMakingProgress(sample.LastAcknowledgedAt, sample.ObservedAt)))
        {
            state = state with { FailureStartedAt = state.FailureStartedAt ?? sample.ObservedAt };
            var oldEnough = sample.ObservedAt - state.FailureStartedAt >= OutageGrace ||
                sample.OldestPendingAt is { } oldest && sample.ObservedAt - oldest >= OutageGrace;
            if (!immediate && !oldEnough || state.OutageWasDelivered ||
                state.LastOutageAttemptAt is { } attempted && sample.ObservedAt - attempted < RetryInterval)
                return DeliveryNotificationAction.None;
            return DeliveryNotificationAction.Outage;
        }

        state = state with { FailureStartedAt = null };
        if (!state.OutageWasDelivered || sample.State is not ("acknowledged" or "up-to-date") ||
            sample.LastAcknowledgedAt is not { } acknowledged ||
            state.AcknowledgedAtOutage is { } previous && acknowledged <= previous ||
            state.LastRecoveryAttemptAt is { } attemptedAt && sample.ObservedAt - attemptedAt < RetryInterval)
            return DeliveryNotificationAction.None;
        return DeliveryNotificationAction.Recovery;
    }

    public void RecordAttempt(DeliveryNotificationAction action, DeliveryNotificationSample sample, bool delivered)
    {
        state = action switch
        {
            DeliveryNotificationAction.Outage => state with { LastOutageAttemptAt = sample.ObservedAt },
            DeliveryNotificationAction.Recovery => state with { LastRecoveryAttemptAt = sample.ObservedAt },
            _ => state,
        };
        if (!delivered) return;
        state = action switch
        {
            DeliveryNotificationAction.Outage => state with
            {
                OutageWasDelivered = true,
                AcknowledgedAtOutage = sample.LastAcknowledgedAt,
            },
            DeliveryNotificationAction.Recovery => new DeliveryNotificationState(),
            _ => state,
        };
    }

    /// Whether the Hub has taken a batch within the grace, so a backlog is
    /// being worked through rather than stuck.
    ///
    /// The oldest pending observation says how far behind delivery is, not
    /// whether it moves. On 2026-11-15 a queue of 10,000 drained in about a
    /// minute while the Hub answered every other batch with 429; its oldest
    /// row was hours old the whole time, so "recovered" was followed sixteen
    /// seconds later by "not completed, 4,257 pending", and the recovery that
    /// should have closed it was held back and shown six days later.
    public static bool IsMakingProgress(DateTimeOffset? lastAcknowledgedAt, DateTimeOffset at) =>
        lastAcknowledgedAt is { } acknowledged && at - acknowledged < OutageGrace;

    public static bool IsFailure(string value) => value is "authorization-required" or "rate-limited" or
        "retryable" or "contract-rejected" or "invalid-acknowledgement" or "hub-incompatible";
}
