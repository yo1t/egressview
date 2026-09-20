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
        // Only what is being lost now. Events dropped while the trace session
        // was starting are already history, and restarting -- the advice this
        // used to give -- would only produce another start and another loss.
        if (collector.EtwEventsLost - collector.EtwEventsLostAtStart > 0)
            issues.Add(new("etw-events-lost", "Export diagnostics; the machine is producing more network events than the Agent can read."));
        if (collector.CollectorError is not null)
            issues.Add(new("collector-error", "Export diagnostics and check the Windows Application event log."));
        // A trace session that is up and delivering nothing.
        //
        // This reported "healthy": no events had been lost, because no events
        // had arrived. Subscribing to two keywords this provider does not
        // define was enough to produce it, and nothing on the screen said so
        // for three minutes. A monitor that records nothing must never be the
        // same colour as one that is working.
        //
        // The other providers are the control. Process and DNS events arriving
        // while network events do not is the trace session working and this
        // subscription being wrong; all three silent is a quiet machine.
        if (collector.EtwSessionActive && collector.EtwEventsSeen == 0 &&
            (collector.NamesFromStartEvents > 0 || collector.DnsEventsSeen > 0))
            issues.Add(new("etw-network-silent",
                "The trace session is running and delivering other events, but no network events. Export diagnostics."));
        var status = issues.Count == 0 ? collector.State : collector.PersistenceFailures > 0 ? "stopped" : "degraded";
        return new(status, issues);
    }
}
