using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

/// Keeps the Windows service alive while the user deliberately pauses only
/// network observation. A marker beside the database preserves that choice
/// across service and machine restarts.
internal sealed class MonitoringController : IAsyncDisposable
{
    private readonly ObservationStore store;
    private readonly ObservationPipeline pipeline;
    private readonly EtwNetworkCollector collector;
    private readonly string disabledMarker;
    private readonly SemaphoreSlim gate = new(1, 1);
    private long? coverageId;
    private DateTimeOffset lastConfirmedAt;
    private int lastEventsLost;

    /// Stop the collector, and record it when the trace session would not let
    /// go in time. The count is what anyone can act on; the wait itself is
    /// already over by the time it is known.
    private void StopCollector()
    {
        collector.StopAsync().GetAwaiter().GetResult();
        if (!collector.StopTimedOut) return;
        try { store.AddCounter("shutdown-collector-stop-timeout", 1); } catch (Exception) { }
    }

    internal MonitoringController(ObservationStore store, ObservationPipeline pipeline, string disabledMarker)
    {
        this.store = store;
        this.pipeline = pipeline;
        this.disabledMarker = disabledMarker;
        collector = new EtwNetworkCollector(pipeline);
        Enabled = !File.Exists(disabledMarker);
        // A marker file like the monitoring one, so the choice survives a
        // restart of the service without the service having to ask the window.
        hostnamesMarker = Path.Combine(Path.GetDirectoryName(disabledMarker) ?? ".", "hostnames.disabled");
        collector.ReadsHostnames = !File.Exists(hostnamesMarker);
    }

    private readonly string hostnamesMarker;

    internal bool Enabled { get; private set; }

    internal bool ReadsHostnames => collector.ReadsHostnames;

    /// Changing this restarts the trace session, because the subscription is
    /// decided when the session is opened. Monitoring stops for the moment it
    /// takes, and the gap is recorded as an interruption rather than hidden:
    /// a coverage figure that quietly ignores its own restarts is worth less
    /// than one that counts them.
    internal bool SetReadsHostnames(bool reads)
    {
        gate.Wait();
        try
        {
            if (reads == collector.ReadsHostnames) return reads;
            if (reads) File.Delete(hostnamesMarker);
            else File.WriteAllText(hostnamesMarker, "Destination-name reading was turned off from the EgressView Agent UI." + Environment.NewLine);
            collector.ReadsHostnames = reads;
            if (Enabled)
            {
                EndCoverage(DateTimeOffset.UtcNow, interrupted: true);
                StopCollector();
                collector.Start();
                BeginCoverage(DateTimeOffset.UtcNow);
            }
            return reads;
        }
        finally { gate.Release(); }
    }

    internal void Start()
    {
        if (!Enabled) return;
        collector.Start();
        BeginCoverage(DateTimeOffset.UtcNow);
    }

    internal CollectorSnapshot Snapshot()
    {
        var pipelineSnapshot = pipeline.Snapshot();
        if (!Enabled) pipelineSnapshot = pipelineSnapshot with { State = "stopped" };
        return collector.Enrich(pipelineSnapshot);
    }

    internal bool SetEnabled(bool enabled)
    {
        gate.Wait();
        try
        {
            if (enabled == Enabled) return Enabled;
            if (enabled)
            {
                collector.Start();
                try { File.Delete(disabledMarker); }
                catch
                {
                    StopCollector();
                    throw;
                }
                Enabled = true;
                BeginCoverage(DateTimeOffset.UtcNow);
            }
            else
            {
                File.WriteAllText(disabledMarker, "Monitoring was paused from the EgressView Agent UI.\r\n");
                Enabled = false;
                EndCoverage(DateTimeOffset.UtcNow, interrupted: false);
                StopCollector();
            }
            return Enabled;
        }
        finally { gate.Release(); }
    }

    internal async Task RunCoverageHeartbeatAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try { await Task.Delay(ObservationStore.CoverageHeartbeatInterval, cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }

            await gate.WaitAsync();
            try
            {
                if (!Enabled) continue;
                var now = DateTimeOffset.UtcNow;
                var eventsLost = collector.EventsLost;
                var pipelineSnapshot = pipeline.Snapshot();
                var healthy = collector.IsActive && collector.Error is null && pipelineSnapshot.PersistenceFailures == 0;
                var suspended = now - lastConfirmedAt > ObservationStore.CoverageStaleAfter;
                var lostEvents = eventsLost > lastEventsLost;

                if (coverageId is not null && (suspended || lostEvents || !healthy))
                    EndCoverage(lastConfirmedAt, interrupted: true);
                if (healthy)
                {
                    if (coverageId is null) BeginCoverage(now);
                    else store.ConfirmCoverage(coverageId.Value, now);
                    lastConfirmedAt = now;
                }
                lastEventsLost = eventsLost;
            }
            finally { gate.Release(); }
        }
    }

    private void BeginCoverage(DateTimeOffset at)
    {
        coverageId = store.BeginCoverage(StartupSnapshot.Capture(), at);
        lastConfirmedAt = at;
        lastEventsLost = collector.EventsLost;
    }

    private void EndCoverage(DateTimeOffset at, bool interrupted)
    {
        if (coverageId is not { } active) return;
        if (interrupted) store.InterruptCoverage(active, at);
        else store.EndCoverage(active, at);
        coverageId = null;
    }

    public async ValueTask DisposeAsync()
    {
        await gate.WaitAsync();
        try
        {
            EndCoverage(DateTimeOffset.UtcNow, interrupted: false);
            await collector.DisposeAsync();
        }
        finally
        {
            gate.Release();
            gate.Dispose();
        }
    }
}
