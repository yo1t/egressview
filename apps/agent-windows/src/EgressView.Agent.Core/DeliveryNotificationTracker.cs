namespace EgressView.Agent.Core;

public enum DeliveryNotificationAction { None, Outage, Recovery }

public sealed record DeliveryNotificationSample(DateTimeOffset ObservedAt, bool Active, string State, long Pending,
    DateTimeOffset? OldestPendingAt, DateTimeOffset? LastAcknowledgedAt);

public sealed record DeliveryNotificationState(DateTimeOffset? FailureStartedAt = null,
    DateTimeOffset? LastOutageAttemptAt = null, DateTimeOffset? LastRecoveryAttemptAt = null, bool OutageWasDelivered = false,
    DateTimeOffset? AcknowledgedAtOutage = null);

public sealed class DeliveryNotificationTracker(DeliveryNotificationState? restored = null)
{
    private static readonly TimeSpan OutageGrace = TimeSpan.FromMinutes(5);
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

        if (IsFailure(sample.State) && sample.Pending > 0)
        {
            state = state with { FailureStartedAt = state.FailureStartedAt ?? sample.ObservedAt };
            var immediate = sample.State is "authorization-required" or "contract-rejected" or
                "invalid-acknowledgement" or "hub-incompatible";
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

    private static bool IsFailure(string value) => value is "authorization-required" or "rate-limited" or
        "retryable" or "contract-rejected" or "invalid-acknowledgement" or "hub-incompatible";
}
