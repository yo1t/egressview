using System.Text.Json;
using System.IO;

namespace EgressView.Agent.Ui;

internal sealed record NotificationHistoryEntry(DateTimeOffset Date, string Kind, string Title, string Body, bool Delivered);

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
    internal int SuppressedToday { get; private set; }

    internal bool Notify(string kind, string key, string title, string body, Action<string, string> show, bool bypassLimits = false)
    {
        if (!AgentSettings.NotificationsEnabled && !bypassLimits) return false;
        var now = DateTimeOffset.Now;
        if (!bypassLimits && ((cooldowns.TryGetValue(key, out var last) && now - last < TimeSpan.FromHours(1)) ||
            SentToday >= AgentSettings.NotificationDailyLimit))
        {
            SuppressedToday++;
            return false;
        }
        cooldowns[key] = now;
        var delivered = true;
        try { show(title, body); }
        catch { delivered = false; }
        history.Insert(0, new NotificationHistoryEntry(now, kind, title, body, delivered));
        if (history.Count > 100) history.RemoveRange(100, history.Count - 100);
        Save();
        return delivered;
    }

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
