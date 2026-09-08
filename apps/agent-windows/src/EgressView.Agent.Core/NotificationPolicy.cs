namespace EgressView.Agent.Core;

public enum NotificationDecision
{
    Deliver,
    Disabled,
    CategoryDisabled,
    Cooldown,
    DailyLimit,
}

public static class NotificationPolicy
{
    public static NotificationDecision Evaluate(
        bool enabled,
        bool categoryEnabled,
        bool monitoringNotification,
        int dailyLimit,
        int deliveredToday,
        DateTimeOffset? lastDeliveredAt,
        DateTimeOffset now,
        bool bypassLimits = false)
    {
        if (!enabled) return NotificationDecision.Disabled;
        if (!categoryEnabled) return NotificationDecision.CategoryDisabled;
        if (bypassLimits) return NotificationDecision.Deliver;
        if (lastDeliveredAt is { } last && now - last < TimeSpan.FromHours(1)) return NotificationDecision.Cooldown;
        if (!monitoringNotification && dailyLimit > 0 && deliveredToday >= dailyLimit) return NotificationDecision.DailyLimit;
        return NotificationDecision.Deliver;
    }
}
