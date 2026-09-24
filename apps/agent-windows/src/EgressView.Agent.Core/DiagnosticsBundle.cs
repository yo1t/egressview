using System.IO.Compression;
using System.Text;

namespace EgressView.Agent.Core;

public static class DiagnosticsBundle
{
    public static void Create(string destination, string diagnosticsJson)
    {
        var fullPath = Path.GetFullPath(destination);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath)!);
        var temporary = $"{fullPath}.tmp-{Guid.NewGuid():N}";
        try
        {
            using (var archive = ZipFile.Open(temporary, ZipArchiveMode.Create))
            {
                Write(archive, "diagnostics.json", diagnosticsJson);
                Write(archive, "diagnostics.txt", RenderText(diagnosticsJson));
                Write(archive, "README.txt", "Privacy-safe EgressView Agent diagnostics. This bundle excludes endpoints, process names, credentials, raw observations, and the SQLite database.\r\n\r\nIf the UI cannot open, run EgressView.Agent.Service.exe --diagnostics-bundle <zip-path> --data <database-path> from an elevated terminal. If that also fails, inspect Windows Event Viewer > Windows Logs > Application > EgressViewAgent (event 1001).\r\n");
            }
            File.Move(temporary, fullPath, true);
        }
        catch
        {
            try { File.Delete(temporary); } catch { }
            throw;
        }
    }

    public static string RenderText(string diagnosticsJson)
    {
        using var document = System.Text.Json.JsonDocument.Parse(diagnosticsJson);
        var root = document.RootElement;
        static string Value(System.Text.Json.JsonElement root, string parent, string name)
        {
            if (!root.TryGetProperty(parent, out var section) || !section.TryGetProperty(name, out var value)) return "not available";
            return value.ValueKind switch { System.Text.Json.JsonValueKind.Null => "not available", System.Text.Json.JsonValueKind.String => value.GetString() ?? "not available", _ => value.ToString() };
        }
        var lines = new[]
        {
            "EgressView Agent for Windows diagnostics",
            $"Generated: {root.GetProperty("generatedAt")}",
            "",
            "This report contains no destination address, host name, process name, credential, raw observation, or database file.",
            "Read diagnostics.json in this ZIP for all privacy-safe counters.",
            "",
            $"Agent version: {Value(root, "build", "version")}",
            $"Windows: {Value(root, "build", "osVersion")}",
            $"Architecture: {Value(root, "build", "architecture")}",
            $"Collector: {Value(root, "collector", "State")}",
            $"ETW session active: {Value(root, "collector", "EtwSessionActive")}",
            $"ETW events seen: {Value(root, "collector", "EtwEventsSeen")}",
            $"Process names from cache / live queries: {Value(root, "collector", "NamesFromCache")} / {Value(root, "collector", "NamesFromLiveQueries")}",
            $"ETW events lost: {Value(root, "collector", "EtwEventsLost")}",
            $"Collector queue drops: {Value(root, "collector", "QueueFullDrops")}",
            $"Persistence failures: {Value(root, "collector", "PersistenceFailures")}",
            $"Snapshot flows: {Value(root, "flows", "snapshot")}",
            $"DNS events / resolved / unavailable: {Value(root, "collector", "DnsEventsSeen")} / {Value(root, "collector", "HostnamesResolved")} / {Value(root, "collector", "HostnamesUnavailable")}",
            $"Last observation: {Value(root, "collector", "LastObservedAt")}",
            $"IPC report channel: {Value(root, "ipc", "reportChannel")}",
            $"Service fallback: {Value(root, "service", "failure")}",
            // Why the service itself last stopped with an error. The line
            // above is why this report could not reach it, which for the
            // window is its own timeout -- true, and not the question.
            $"Service failures on record: {ServiceFailures(root)}",
            $"Database integrity: {Value(root, "database", "integrity")}",
            $"Database bytes: {Value(root, "database", "storageBytes")}",
            $"Hub queue pending: {Value(root, "delivery", "pending")}",
            $"Hub queue overflow: {Value(root, "delivery", "queueOverflow")}",
            $"Hub contract rejected: {Value(root, "delivery", "contractRejected")}",
            $"Last Hub ACK: {Value(root, "delivery", "lastAcknowledgedAt")}",
            $"Installer state: {Value(root, "installer", "state")}",
            $"Installer version: {Value(root, "installer", "version")}",
        };
        return string.Join("\r\n", lines) + "\r\n";
    }

    /// "none recorded", or how many and the latest, in a form a person can
    /// read without opening the JSON.
    private static string ServiceFailures(System.Text.Json.JsonElement root)
    {
        if (!root.TryGetProperty("serviceFailures", out var list)
            || list.ValueKind != System.Text.Json.JsonValueKind.Array
            || list.GetArrayLength() == 0)
            return "none recorded";
        var last = list[list.GetArrayLength() - 1];
        string Field(System.Text.Json.JsonElement element, string name) =>
            element.TryGetProperty(name, out var value) && value.ValueKind != System.Text.Json.JsonValueKind.Null
                ? value.ToString() : string.Empty;
        var kind = Field(last, "storeFailure");
        var where = string.Empty;
        if (last.TryGetProperty("migration", out var m) && m.ValueKind == System.Text.Json.JsonValueKind.Object)
        {
            var steps = Field(m, "steps");
            where = steps is "" or "0"
                ? $" during the migration to schema v{Field(m, "toVersion")}"
                : $" during the migration to schema v{Field(m, "toVersion")}, step {Field(m, "step")} of {steps}";
        }
        return $"{list.GetArrayLength()}; latest {Field(last, "at")} {Field(last, "exceptionType")}"
               + (kind.Length > 0 ? $" ({kind})" : string.Empty) + where;
    }

    private static void Write(ZipArchive archive, string name, string content)
    {
        using var stream = archive.CreateEntry(name, CompressionLevel.Optimal).Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
