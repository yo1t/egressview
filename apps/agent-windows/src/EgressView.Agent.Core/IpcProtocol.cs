using System.Text.Json;

namespace EgressView.Agent.Core;

public static class IpcProtocol
{
    public const int Version = 1;

    public static string Handle(string request, Func<string> status, Func<int, IReadOnlyList<HourlySummary>> summary)
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
                _ => Reject("unknown-operation"),
            };
        }
        catch (Exception) { return Reject("malformed-request"); }
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
