using System.Text.Json;

namespace EgressView.Agent.Core;

public static class IpcProtocol
{
    public const int Version = 1;

    public static string Handle(string request, Func<string> status, Func<int, IReadOnlyList<HourlySummary>> summary,
        Action<AgentCredential>? saveCredential = null, Action<bool>? setDeliveryEnabled = null,
        Func<int, int, IReadOnlyList<RecentFlow>>? recentFlows = null)
    {
        try
        {
            using var document = JsonDocument.Parse(request);
            var root = document.RootElement;
            if (!root.TryGetProperty("v", out var version) || version.GetInt32() != Version)
                return Reject("version-mismatch");
            var operation = root.TryGetProperty("op", out var op) ? op.GetString() : null;
            return operation switch
            {
                "status" => Status(status),
                "summary" => Summary(root, summary),
                "recent-flows" => RecentFlows(root, recentFlows),
                "save-enrollment" => SaveEnrollment(root, saveCredential),
                "set-delivery-enabled" => SetDeliveryEnabled(root, setDeliveryEnabled),
                _ => Reject("unknown-operation"),
            };
        }
        catch (Exception) { return Reject("malformed-request"); }
    }

    private static string RecentFlows(JsonElement root, Func<int, int, IReadOnlyList<RecentFlow>>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var limit = root.TryGetProperty("limit", out var value) ? value.GetInt32() : 0;
        if (limit is not (50 or 100 or 200 or 500)) return Reject("invalid-limit");
        var offset = root.TryGetProperty("offset", out var offsetValue) ? offsetValue.GetInt32() : 0;
        if (offset is < 0 or > 1_000_000) return Reject("invalid-offset");
        return JsonSerializer.Serialize(new { status = "ok", limit, offset, data = read(limit, offset) });
    }

    private static string SetDeliveryEnabled(JsonElement root, Action<bool>? set)
    {
        if (set is null || !root.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Reject("invalid-delivery-setting");
        try { set(value.GetBoolean()); }
        catch { return Reject("delivery-setting-failed"); }
        return JsonSerializer.Serialize(new { status = "ok", enabled = value.GetBoolean() });
    }

    private static string SaveEnrollment(JsonElement root, Action<AgentCredential>? save)
    {
        if (save is null || !root.TryGetProperty("credential", out var value)) return Reject("operation-unavailable");
        var credential = value.Deserialize<AgentCredential>();
        if (credential is null || !AgentEnrollmentClient.IsValidCredential(credential)) return Reject("invalid-credential");
        try { save(credential); }
        catch { return Reject("credential-storage-failed"); }
        return JsonSerializer.Serialize(new { status = "ok" });
    }

    private static string Status(Func<string> read)
    {
        using var document = JsonDocument.Parse(read());
        return JsonSerializer.Serialize(new { status = "ok", data = document.RootElement.Clone() });
    }

    private static string Summary(JsonElement root, Func<int, IReadOnlyList<HourlySummary>> read)
    {
        var days = root.TryGetProperty("days", out var value) ? value.GetInt32() : 0;
        if (days is not (7 or 30)) return Reject("invalid-range");
        return JsonSerializer.Serialize(new { status = "ok", days, data = read(days) });
    }

    private static string Reject(string reason) => JsonSerializer.Serialize(new { status = "rejected", reason });
}
