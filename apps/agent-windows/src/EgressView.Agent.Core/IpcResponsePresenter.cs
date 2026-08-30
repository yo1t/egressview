using System.Globalization;
using System.Text.Json;

namespace EgressView.Agent.Core;

public static class IpcResponsePresenter
{
    public static string Present(string response)
    {
        using var document = JsonDocument.Parse(response);
        var root = document.RootElement;
        if (root.GetProperty("status").GetString() != "ok")
            return $"要求を完了できませんでした / Request rejected\r\n理由 / Reason: {ReadString(root, "reason", "unknown")}";

        return root.TryGetProperty("days", out var days)
            ? PresentSummary(days.GetInt32(), root.GetProperty("data"))
            : PresentStatus(root.GetProperty("data"));
    }

    private static string PresentStatus(JsonElement data)
    {
        var health = data.GetProperty("health");
        var database = data.GetProperty("database");
        var collector = data.GetProperty("collector");
        var status = ReadString(health, "status", "unknown");
        var last = ReadNullableDate(collector, "LastPersistedAt");
        var issues = health.TryGetProperty("issues", out var issueArray) ? issueArray.GetArrayLength() : 0;
        return string.Join("\r\n",
            $"状態 / Health: {status}",
            $"保存済み観測数 / Stored observations: {database.GetProperty("observationCount").GetInt64():N0}",
            $"データベース / Database: {ReadString(database, "integrity", "unknown")}",
            $"最終保存 / Last stored: {(last is null ? "—" : last.Value.ToLocalTime().ToString("g", CultureInfo.CurrentCulture))}",
            $"要確認項目 / Issues: {issues:N0}");
    }

    private static string PresentSummary(int days, JsonElement rows)
    {
        long observations = 0, sent = 0, received = 0, unknown = 0;
        foreach (var row in rows.EnumerateArray())
        {
            observations += row.GetProperty("ObservationCount").GetInt64();
            sent += row.GetProperty("BytesSent").GetInt64();
            received += row.GetProperty("BytesReceived").GetInt64();
            unknown += row.GetProperty("BytesUnknown").GetInt64();
        }

        return string.Join("\r\n",
            $"期間 / Period: 過去{days}日 / Last {days} days",
            $"観測数 / Observations: {observations:N0}",
            $"送信 / Sent: {FormatBytes(sent)}",
            $"受信 / Received: {FormatBytes(received)}",
            $"通信量不明 / Unknown bytes: {unknown:N0}");
    }

    private static string FormatBytes(long bytes)
    {
        string[] units = ["B", "KiB", "MiB", "GiB", "TiB"];
        var value = (double)bytes;
        var unit = 0;
        while (value >= 1024 && unit < units.Length - 1) { value /= 1024; unit++; }
        return $"{value:N1} {units[unit]}";
    }

    private static string ReadString(JsonElement element, string name, string fallback) =>
        element.TryGetProperty(name, out var value) ? value.GetString() ?? fallback : fallback;

    private static DateTimeOffset? ReadNullableDate(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind != JsonValueKind.Null ? value.GetDateTimeOffset() : null;
}
