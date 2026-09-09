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
            $"ETW events lost: {Value(root, "collector", "EtwEventsLost")}",
            $"Collector queue drops: {Value(root, "collector", "QueueFullDrops")}",
            $"Persistence failures: {Value(root, "collector", "PersistenceFailures")}",
            $"Snapshot flows: {Value(root, "flows", "snapshot")}",
            $"DNS events / resolved / unavailable: {Value(root, "collector", "DnsEventsSeen")} / {Value(root, "collector", "HostnamesResolved")} / {Value(root, "collector", "HostnamesUnavailable")}",
            $"Last observation: {Value(root, "collector", "LastObservedAt")}",
            $"IPC report channel: {Value(root, "ipc", "reportChannel")}",
            $"Service fallback: {Value(root, "service", "failure")}",
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

    private static void Write(ZipArchive archive, string name, string content)
    {
        using var stream = archive.CreateEntry(name, CompressionLevel.Optimal).Open();
        using var writer = new StreamWriter(stream, new UTF8Encoding(false));
        writer.Write(content);
    }
}
