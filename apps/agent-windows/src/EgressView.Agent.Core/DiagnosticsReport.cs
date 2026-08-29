using System.Text.Json;

namespace EgressView.Agent.Core;

public static class DiagnosticsReport
{
    public static string Create(CollectorSnapshot snapshot, ObservationStore store, string version)
    {
        var (count, integrity) = store.Inspect();
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            version,
            collector = snapshot,
            database = new { observationCount = count, integrity, durableCounters = store.ReadCounters() },
            privacy = new { includesEndpoints = false, includesProcessNames = false, includesCredentials = false },
        }, new JsonSerializerOptions { WriteIndented = true });
    }
}
