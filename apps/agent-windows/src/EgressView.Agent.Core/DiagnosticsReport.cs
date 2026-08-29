using System.Text.Json;

namespace EgressView.Agent.Core;

public static class DiagnosticsReport
{
    public static string Create(CollectorSnapshot snapshot, ObservationStore store, string version)
    {
        var (count, integrity) = store.Inspect();
        var coverage = store.ReadCoverage();
        var flowStats = store.ReadFlowStats();
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            version,
            collector = snapshot,
            database = new { observationCount = count, integrity, durableCounters = store.ReadCounters() },
            flows = new { total = flowStats.Total, snapshot = flowStats.Snapshot, etw = flowStats.Etw, both = flowStats.Both, bytesUnknown = flowStats.BytesUnknown, byOrigin = store.ReadFlowOrigins() },
            coverage = new { total = coverage.Total, active = coverage.Active, abandoned = coverage.Abandoned },
            privacy = new { includesEndpoints = false, includesProcessNames = false, includesCredentials = false },
        }, new JsonSerializerOptions { WriteIndented = true });
    }
}
