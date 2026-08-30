using System.Text.Json;

namespace EgressView.Agent.Core;

public static class DiagnosticsReport
{
    public static string Create(CollectorSnapshot snapshot, ObservationStore store, string version)
    {
        var (count, integrity) = store.Inspect();
        var coverage = store.ReadCoverage();
        var flowStats = store.ReadFlowStats();
        var processNames = store.ReadProcessNameStats();
        var delivery = store.ReadDeliveryStatus();
        var health = AgentHealth.Evaluate(snapshot, integrity);
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            version,
            collector = snapshot,
            health = new { status = health.Status, issues = health.Issues.Select(issue => new { code = issue.Code, action = issue.Action }) },
            database = new { observationCount = count, integrity, schemaVersion = store.SchemaVersion, durableCounters = store.ReadCounters() },
            flows = new { total = flowStats.Total, snapshot = flowStats.Snapshot, etw = flowStats.Etw, both = flowStats.Both, bytesUnknown = flowStats.BytesUnknown, processNames = new { resolved = processNames.Resolved, unresolved = processNames.Unresolved }, byOrigin = store.ReadFlowOrigins() },
            coverage = new { total = coverage.Total, active = coverage.Active, abandoned = coverage.Abandoned },
            delivery = new { pending = delivery.Pending, contractRejected = delivery.ContractRejected, queueOverflow = delivery.QueueOverflow, oldestPendingAt = delivery.OldestPendingAt, lastAcknowledgedAt = delivery.LastAcknowledgedAt },
            privacy = new { includesEndpoints = false, includesProcessNames = false, includesCredentials = false },
        }, new JsonSerializerOptions { WriteIndented = true });
    }
}
