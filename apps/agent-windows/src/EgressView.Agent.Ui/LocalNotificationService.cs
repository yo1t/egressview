using System.Text.Json;
using System.IO;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

internal sealed record NotificationHistoryEntry(DateTimeOffset Date, string Kind, string Title, string Body, bool Delivered, string Outcome = "shown");

internal sealed class LocalNotificationService
{
    private readonly string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "EgressView", "Agent", "notification-history.json");
    private readonly List<NotificationHistoryEntry> history;
    private readonly Dictionary<string, DateTimeOffset> cooldowns = [];

    internal LocalNotificationService()
    {
        try { history = JsonSerializer.Deserialize<List<NotificationHistoryEntry>>(File.ReadAllText(path)) ?? []; }
        catch { history = []; }
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

    private void Add(NotificationHistoryEntry item)
    {
        history.Insert(0, item);
        if (history.Count > 100) history.RemoveRange(100, history.Count - 100);
        Save();
    }

    private static string Redact(string body) => body.IndexOfAny(['.', ':']) >= 0 ? "EgressView Agent status changed. Open the app for details." : body;

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
}
