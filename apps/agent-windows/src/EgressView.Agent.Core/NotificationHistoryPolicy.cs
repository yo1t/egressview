namespace EgressView.Agent.Core;

/// What the notification history keeps when the same thing happens repeatedly.
///
/// Every attempt was recorded, including the ones policy suppressed, into a
/// list capped at a hundred. A degraded agent is re-evaluated on the UI's
/// five-second refresh, so a single unhealthy minute writes twelve identical
/// "suppressed-cooldown" rows. Measured on a real machine: 94 of the 100 slots
/// held the same suppressed message, the remaining six held every notification
/// actually shown in a day, and a real outbound-anomaly notice was three rows
/// from being evicted by its own agent's noise.
///
/// Suppressed attempts are still worth keeping -- "we would have told you, and
/// did not" is the answer to "why did nothing appear". They are worth keeping
/// once, with a count, rather than once per refresh.
public static class NotificationHistoryPolicy
{
    public const int Capacity = 100;

    /// Whether this attempt only repeats the newest entry.
    ///
    /// Restricted to suppressed attempts: two notifications actually shown are
    /// two events the reader wants separately, even when they say the same
    /// thing, because each one interrupted them.
    public static bool RepeatsNewest(string kind, string body, string outcome,
        string? newestKind, string? newestBody, string? newestOutcome) =>
        IsSuppressed(outcome)
        && IsSuppressed(newestOutcome)
        && string.Equals(outcome, newestOutcome, StringComparison.Ordinal)
        && string.Equals(kind, newestKind, StringComparison.Ordinal)
        && string.Equals(body, newestBody, StringComparison.Ordinal);

    public static bool IsSuppressed(string? outcome) =>
        outcome is not null && outcome.StartsWith("suppressed-", StringComparison.Ordinal);
}
