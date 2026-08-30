namespace EgressView.Agent.Core;

public sealed record HealthIssue(string Code, string Action);
public sealed record AgentHealth(string Status, IReadOnlyList<HealthIssue> Issues)
{
    public static AgentHealth Evaluate(CollectorSnapshot collector, string integrity)
    {
        var issues = new List<HealthIssue>();
        if (!string.Equals(integrity, "ok", StringComparison.Ordinal))
            issues.Add(new("database-corrupt", "Restore the pre-migration backup or contact support; do not delete the database."));
        if (collector.PersistenceFailures > 0)
            issues.Add(new(collector.PersistenceError ?? "persistence-failed", "Free disk space or restore database access, then restart the EgressView Agent service."));
        if (collector.EtwEventsLost > 0)
            issues.Add(new("etw-events-lost", "Export diagnostics and restart the EgressView Agent service."));
        if (collector.CollectorError is not null)
            issues.Add(new("collector-error", "Export diagnostics and check the Windows Application event log."));
        var status = issues.Count == 0 ? collector.State : collector.PersistenceFailures > 0 ? "stopped" : "degraded";
        return new(status, issues);
    }
}
