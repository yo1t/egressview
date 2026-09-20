using System.Text.Json;
using System.IO;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

/// <param name="Repeats">
/// How many identical suppressed attempts this row stands for. One for
/// everything shown, and for the first of a run. Entries written before this
/// existed deserialize as zero, which reads the same as one and is not worth a
/// migration.
/// </param>
internal sealed record NotificationHistoryEntry(DateTimeOffset Date, string Kind, string Title, string Body, bool Delivered, string Outcome = "shown", int Repeats = 1);

internal sealed class LocalNotificationService
{
    private readonly string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "EgressView", "Agent", "notification-history.json");
    private readonly string deliveryStatePath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "EgressView", "Agent", "delivery-notification-state.json");
    private readonly List<NotificationHistoryEntry> history;
    private readonly Dictionary<string, DateTimeOffset> cooldowns = [];
    private readonly DeliveryNotificationTracker deliveryNotifications;

    internal LocalNotificationService()
    {
        try { history = JsonSerializer.Deserialize<List<NotificationHistoryEntry>>(File.ReadAllText(path)) ?? []; }
        catch { history = []; }
        try
        {
            var restored = JsonSerializer.Deserialize<DeliveryNotificationState>(File.ReadAllText(deliveryStatePath));
            deliveryNotifications = new(restored);
        }
        catch { deliveryNotifications = new(); }
    }

    internal IReadOnlyList<NotificationHistoryEntry> History => history;
    internal int SentToday => history.Count(item => item.Date.LocalDateTime.Date == DateTime.Today && item.Delivered);
    internal int AttemptsToday => history.Count(item => item.Date.LocalDateTime.Date == DateTime.Today);
    internal int SuppressedToday => history.Count(item => item.Date.LocalDateTime.Date == DateTime.Today && item.Outcome.StartsWith("suppressed-", StringComparison.Ordinal));

    internal bool Notify(string kind, string key, string title, string body, Action<string, string> show, bool bypassLimits = false)
    {
        var now = DateTimeOffset.Now;
        var decision = NotificationPolicy.Evaluate(
            AgentSettings.NotificationsEnabled,
            AgentSettings.NotificationCategoryEnabled(kind),
            string.Equals(kind, "Monitoring", StringComparison.Ordinal),
            AgentSettings.NotificationDailyLimit,
            SentToday,
            cooldowns.TryGetValue(key, out var last) ? last : null,
            now,
            bypassLimits);
        if (decision != NotificationDecision.Deliver)
        {
            Add(new NotificationHistoryEntry(now, kind, title, Redact(body), false, $"suppressed-{DecisionName(decision)}"));
            return false;
        }
        cooldowns[key] = now;
        var delivered = true;
        try { show(title, body); }
        catch { delivered = false; }
        Add(new NotificationHistoryEntry(now, kind, title, Redact(body), delivered, delivered ? "shown" : "delivery-failed"));
        return delivered;
    }

    internal void ObserveHubDelivery(DeliveryNotificationSample sample, Action<string, string> show)
    {
        var action = deliveryNotifications.Evaluate(sample);
        if (action == DeliveryNotificationAction.None)
        {
            SaveDeliveryState();
            return;
        }
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var delivered = action == DeliveryNotificationAction.Outage
            ? Notify("HubDelivery", "hub-delivery-outage", "EgressView Agent",
                ja ? $"Hubへの送信が完了していません。未送信 {sample.Pending:N0} 件。Agentを開いて確認してください。"
                   : $"Delivery to the Hub is not completing. {sample.Pending:N0} observations are pending. Open the Agent for details.", show)
            : Notify("Recovery", "hub-delivery-recovery", "EgressView Agent",
                ja ? "Hubへの送信が復旧し、ACKを確認しました。" : "Hub delivery recovered and an acknowledgement was confirmed.", show);
        deliveryNotifications.RecordAttempt(action, sample, delivered);
        SaveDeliveryState();
    }

    private void Add(NotificationHistoryEntry item)
    {
        // A run of identical suppressed attempts is one fact with a count, not
        // one row per refresh. Folding it here is what stops the agent's own
        // five-second re-evaluation from evicting the notifications a reader
        // came to the list to find.
        var newest = history.Count > 0 ? history[0] : null;
        if (newest is not null && NotificationHistoryPolicy.RepeatsNewest(
                item.Kind, item.Body, item.Outcome, newest.Kind, newest.Body, newest.Outcome))
        {
            history[0] = newest with { Date = item.Date, Repeats = Math.Max(1, newest.Repeats) + 1 };
            Save();
            return;
        }
        history.Insert(0, item);
        if (history.Count > NotificationHistoryPolicy.Capacity)
            history.RemoveRange(NotificationHistoryPolicy.Capacity, history.Count - NotificationHistoryPolicy.Capacity);
        Save();
    }

    private static string Redact(string body) => NotificationRedaction.Apply(body);

    private static string DecisionName(NotificationDecision decision) => decision switch
    {
        NotificationDecision.Disabled => "disabled",
        NotificationDecision.CategoryDisabled => "category",
        NotificationDecision.Cooldown => "cooldown",
        NotificationDecision.DailyLimit => "daily-limit",
        _ => "unknown",
    };

    internal void Clear() { history.Clear(); Save(); }

    private void Save()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            File.WriteAllText(path, JsonSerializer.Serialize(history));
        }
        catch { /* History is useful but must never interfere with monitoring. */ }
    }

    private void SaveDeliveryState()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(deliveryStatePath)!);
            File.WriteAllText(deliveryStatePath, JsonSerializer.Serialize(deliveryNotifications.State));
        }
        catch { /* Notification state must never interfere with monitoring. */ }
    }
}
