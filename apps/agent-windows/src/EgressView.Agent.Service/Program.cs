using System.ServiceProcess;
using System.IO.Pipes;
using System.Text;
using Microsoft.Win32;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (IsCommandLineRequest(args))
        {
            try
            {
                if (args.Contains("--console", StringComparer.OrdinalIgnoreCase))
                    return RunConsoleAsync(args).GetAwaiter().GetResult();
                if (args.Contains("--inspect", StringComparer.OrdinalIgnoreCase))
                    return Inspect(args);
                if (args.Contains("--diagnostics-bundle", StringComparer.OrdinalIgnoreCase))
                    return ExportBundle(args);
                return IpcRequest(args);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine(CommandLineFailureMessage(ex));
                return 4;
            }
        }

        ServiceBase.Run(new AgentWindowsService());
        return 0;
    }

    private static bool IsCommandLineRequest(string[] args) =>
        args.Contains("--console", StringComparer.OrdinalIgnoreCase) ||
        args.Contains("--inspect", StringComparer.OrdinalIgnoreCase) ||
        args.Contains("--diagnostics-bundle", StringComparer.OrdinalIgnoreCase) ||
        args.Contains("--ipc-request", StringComparer.OrdinalIgnoreCase);

    internal static string CommandLineFailureMessage(Exception exception) => exception switch
    {
        ArgumentException argument => $"EgressView Agent command failed: {argument.Message}",
        UnauthorizedAccessException => "EgressView Agent command failed: IPC access denied.",
        System.TimeoutException => "EgressView Agent command failed: IPC connection timed out.",
        IOException => "EgressView Agent command failed: an I/O operation failed.",
        _ => $"EgressView Agent command failed ({exception.GetType().Name})."
    };

    private static int IpcRequest(string[] args)
    {
        var request = Argument(args, "--ipc-request") ?? throw new ArgumentException("--ipc-request JSON is required");
        using var client = new NamedPipeClientStream(".", AgentIpcServer.PipeName, PipeDirection.InOut);
        client.Connect(5_000);
        using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, true);
        writer.WriteLine(request);
        Console.WriteLine(reader.ReadLine());
        return 0;
    }

    internal static int ExportBundle(string[] args)
    {
        var database = Argument(args, "--data") ?? throw new ArgumentException("--data is required");
        var destination = Argument(args, "--diagnostics-bundle") ?? throw new ArgumentException("--diagnostics-bundle path is required");
        string report;
        try
        {
            using var store = new ObservationStore(database);
            report = DiagnosticsReport.Create(new CollectorSnapshot("stopped", 0, 0, 0, 0, null, null, 0), store, DiagnosticsReport.CurrentVersion, verifyIntegrity: true);
        }
        catch (Exception exception)
        {
            report = DiagnosticsReport.CreateFallback(DiagnosticsReport.CurrentVersion, exception.GetType().Name);
        }
        DiagnosticsBundle.Create(destination, report);
        return 0;
    }

    private static int Inspect(string[] args)
    {
        var database = Argument(args, "--data") ?? throw new ArgumentException("--data is required");
        using var store = new ObservationStore(database);
        Console.WriteLine(DiagnosticsReport.Create(
            new CollectorSnapshot("stopped", 0, 0, 0, 0, null, null, 0), store, DiagnosticsReport.CurrentVersion, verifyIntegrity: true));
        return 0;
    }

    private static async Task<int> RunConsoleAsync(string[] args)
    {
        var database = Argument(args, "--data") ?? Path.Combine(AppContext.BaseDirectory, "data", "egressview-agent.db");
        var seconds = int.TryParse(Argument(args, "--seconds"), out var parsed) ? parsed : 15;
        using var store = new ObservationStore(database);
        var snapshot = StartupSnapshot.Capture();
        var coverageId = store.BeginCoverage(snapshot, DateTimeOffset.UtcNow);
        await using var pipeline = new ObservationPipeline(store, deliveryEnabled: () => store.DeliveryEnabled);
        await using var collector = new EtwNetworkCollector(pipeline);
        try { collector.Start(); }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 2; }
        await Task.WhenAny(Task.Delay(TimeSpan.FromSeconds(seconds)), pipeline.Completion);
        var snapshotAfterRun = collector.Enrich(pipeline.Snapshot());
        if (snapshotAfterRun.PersistenceFailures == 0) store.EndCoverage(coverageId, DateTimeOffset.UtcNow);
        var diagnostics = DiagnosticsReport.Create(snapshotAfterRun, store, DiagnosticsReport.CurrentVersion);
        Console.WriteLine(diagnostics);
        if (Argument(args, "--diagnostics") is { } diagnosticsPath)
            File.WriteAllText(diagnosticsPath, diagnostics);
        return collector.Error is null && collector.EventsLost == 0 && snapshotAfterRun.PersistenceFailures == 0 ? 0 : 3;
    }

    internal static string? Argument(string[] args, string name)
    {
        var index = Array.FindIndex(args, value => string.Equals(value, name, StringComparison.OrdinalIgnoreCase));
        return index >= 0 && index + 1 < args.Length ? args[index + 1] : null;
    }
}

internal sealed class AgentWindowsService : ServiceBase
{
    private CancellationTokenSource? stop;
    private Task? worker;
    private ObservationStore? activeStore;
    private long activeRunId;

    public AgentWindowsService()
    {
        ServiceName = "EgressViewAgent";
        CanHandlePowerEvent = true;
        // Without this, Windows never calls OnShutdown, and every restart of
        // the machine is indistinguishable from a crash.
        CanShutdown = true;
    }

    protected override void OnStart(string[] args)
    {
        stop = new CancellationTokenSource();
        worker = Task.Run(async () =>
        {
            try { await RunAsync(stop.Token); }
            catch (ShutdownIncompleteException incomplete)
            {
                // The body finished; only the tear-down did not. The service
                // stopped, so reporting a failed start would put an untrue
                // "terminated unexpectedly" in the event log for what was a
                // successful, if slow, shutdown. What was not written is worth
                // recording; a false alarm is not.
                WriteStartupFailure(incomplete);
            }
            catch (Exception ex)
            {
                WriteStartupFailure(ex);
                WriteEventLogFailure(ex);
                Environment.Exit(1);
            }
        });
    }

    protected override void OnStop()
    {
        stop?.Cancel();
        try { worker?.Wait(TimeSpan.FromSeconds(20)); } catch { }
        stop?.Dispose();
    }

    /// The machine is going down, which is not the same event as this service
    /// being stopped, and the record should not say it is.
    ///
    /// The ending is written first and the stop attempted afterwards: Windows
    /// gives a shutting-down service only seconds, and being killed partway
    /// through the tear-down is the expected case rather than the exception.
    /// Whatever else is lost, the reason is already on disk.
    protected override void OnShutdown()
    {
        var runId = Interlocked.Read(ref activeRunId);
        if (runId != 0)
        {
            try { activeStore?.EndSystemShutdownRun(runId); }
            catch (Exception exception) { WriteEventLogFailure(exception); }
        }
        OnStop();
    }

    protected override bool OnPowerEvent(PowerBroadcastStatus powerStatus)
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            if (powerStatus == PowerBroadcastStatus.Suspend) activeStore?.BeginSleepPeriod(now);
            else if (powerStatus is PowerBroadcastStatus.ResumeAutomatic or PowerBroadcastStatus.ResumeSuspend)
                activeStore?.EndSleepPeriod(now);
        }
        catch (Exception exception) { WriteEventLogFailure(exception); }
        return true;
    }

    private async Task RunAsync(CancellationToken cancellationToken)
    {
        var root = Path.Combine(AppContext.BaseDirectory, "data");
        Directory.CreateDirectory(root);
        using var store = new ObservationStore(Path.Combine(root, "egressview-agent.db"));
        activeStore = store;
        // A hibernate/update sequence can restart the service instead of
        // delivering Resume. Startup is the conservative end of that sleep.
        store.EndSleepPeriod(DateTimeOffset.UtcNow);
        // Opened before anything else can fail, and closed last. A run that is
        // still marked open when the next one starts is how a process that was
        // killed gets to say so, since it cannot say anything itself.
        var runId = store.BeginRun(RunComponent.Service, DiagnosticsReport.CurrentVersion);
        Interlocked.Exchange(ref activeRunId, runId);
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            try { store.FaultRun(runId, (e.ExceptionObject as Exception)?.GetType().FullName ?? "Unknown"); } catch { }
        };
        var bodyCompleted = false;
        try
        {
        // A scope of its own, so everything in it is torn down before the run
        // is recorded. Disposing after the record meant a shutdown that failed
        // to drain was still filed as clean.
        {
        await using var pipeline = new ObservationPipeline(store, deliveryEnabled: () => store.DeliveryEnabled);
        await using var monitoring = new MonitoringController(store, pipeline, Path.Combine(root, "monitoring.disabled"));
        monitoring.Start();
        var credentialStore = new WindowsCredentialStore();
        using var deliveryController = new DeliveryController(store, credentialStore);
        using var enrichmentController = new EnrichmentController(store, credentialStore);
        await using var ipc = new AgentIpcServer(store, monitoring.Snapshot, ReadAllowedUserSid(), credentialStore,
            () => monitoring.Enabled, monitoring.SetEnabled, () => monitoring.ReadsHostnames, monitoring.SetReadsHostnames,
            deliveryController, enrichmentController);
        ipc.Start();
        var delivery = deliveryController.RunAsync(cancellationToken);
        var geoCache = enrichmentController.RunGeoAsync(cancellationToken);
        var threatIntel = enrichmentController.RunThreatAsync(cancellationToken);
        var chartAggregation = RunChartAggregationAsync(store, cancellationToken);
        var maintenance = RunMaintenanceAsync(store, cancellationToken);
        var outboundAnomalies = RunOutboundAnomalyAsync(store, cancellationToken);
        var coverage = monitoring.RunCoverageHeartbeatAsync(cancellationToken);
        var runHeartbeat = RunHeartbeatAsync(store, runId, cancellationToken);
        Task lifetime;
        try
        {
            lifetime = Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            var completed = await Task.WhenAny(lifetime, pipeline.Completion);
            if (completed == pipeline.Completion)
            {
                var snapshotAfterFailure = pipeline.Snapshot();
                if (snapshotAfterFailure.PersistenceFailures > 0)
                    throw new InvalidOperationException($"Persistence stopped: {snapshotAfterFailure.PersistenceError ?? "unknown"}");
            }
            await lifetime;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        await coverage;
        await runHeartbeat;
        await delivery;
        await geoCache;
        await threatIntel;
        await chartAggregation;
        await maintenance;
        await outboundAnomalies;
        File.WriteAllText(Path.Combine(root, "diagnostics.json"),
            DiagnosticsReport.Create(monitoring.Snapshot(), store, DiagnosticsReport.CurrentVersion, monitoring.Enabled,
                capabilityStatus: deliveryController.CapabilityStatus));
        bodyCompleted = true;
        }
        // Everything above has been disposed by here, so this is the first
        // point at which "clean" is a true thing to say.
        store.EndRun(runId);
        }
        catch (Exception exception)
        {
            try { store.FaultRun(runId, exception.GetType().FullName ?? "Unknown"); } catch { }
            // The work finished and only the tear-down failed. That is a slow
            // stop, not a crash, and the caller must not report it as one.
            if (bodyCompleted) throw new ShutdownIncompleteException(exception);
            throw;
        }
        finally { activeStore = null; Interlocked.Exchange(ref activeRunId, 0); }
    }

    /// A sign of life, so that a run which ends without warning can be dated
    /// to when it was last known to be working rather than to whenever the
    /// next start happened to notice. Without it, a machine left off for a
    /// week would report a week-long crash.
    private static async Task RunHeartbeatAsync(ObservationStore store, long runId, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try { await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            try { store.Heartbeat(runId); } catch { /* Losing a heartbeat must not stop collection. */ }
        }
    }

    private static async Task RunChartAggregationAsync(ObservationStore store, CancellationToken cancellationToken)
    {
        // Let startup finish and IPC become available before a legacy database
        // performs its one-time fold of retained observations.
        await Task.Yield();
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var rows = store.FoldCompletedHoursForCharts(DateTimeOffset.UtcNow);
                if (rows > 0) store.AddCounter("chart-hourly-rows-folded", rows);
            }
            catch
            {
                try { store.AddCounter("chart-hourly-fold-failure", 1); }
                catch { /* The original store failure remains visible through diagnostics. */ }
            }
            try { await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    /// Watches for outbound traffic that does not look like this machine.
    ///
    /// The detector is the Mac Agent's, thresholds and all, and it needs a
    /// full day of measured windows before it will say anything. Until then
    /// it returns nothing -- which is not the same as "nothing unusual", and
    /// the counter names keep the two apart.
    private static async Task RunOutboundAnomalyAsync(ObservationStore store, CancellationToken cancellationToken)
    {
        var detector = new OutboundAnomalyDetector();
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                // Capturing is idempotent per window, so checking more often
                // than the window length costs a COUNT and finds the window
                // sooner after a restart.
                if (store.CaptureOutboundTrafficWindow(DateTimeOffset.UtcNow) is { } captured)
                {
                    store.AddCounter("outbound-windows-captured", 1);
                    if (detector.Evaluate(captured.Current, captured.Baseline) is { } finding)
                    {
                        store.RecordOutboundAnomaly(finding.Window.StartedAt, finding.Kind);
                        store.AddCounter(finding.Kind == OutboundAnomalyKind.DistributedTransfer
                            ? "outbound-anomaly-distributed" : "outbound-anomaly-large", 1);
                    }
                }
            }
            catch
            {
                try { store.AddCounter("outbound-anomaly-failure", 1); }
                catch { /* The original store failure remains visible through diagnostics. */ }
            }
            try { await Task.Delay(TimeSpan.FromMinutes(1), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private static async Task RunMaintenanceAsync(ObservationStore store, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                // Preserve application-level history before raw retention can
                // remove it during the first maintenance pass after upgrade.
                var chartRows = store.FoldCompletedHoursForCharts(DateTimeOffset.UtcNow);
                if (chartRows > 0) store.AddCounter("chart-hourly-rows-folded", chartRows);
                RetentionMaintenanceResult result;
                do
                {
                    result = store.PruneRetentionBatch(DateTimeOffset.UtcNow);
                    if (result.ObservationsDeleted > 0) store.AddCounter("retention-observations-deleted", result.ObservationsDeleted);
                    if (result.FlowsDeleted > 0) store.AddCounter("retention-flows-deleted", result.FlowsDeleted);
                    if (result.HourlySummariesDeleted > 0) store.AddCounter("retention-hourly-deleted", result.HourlySummariesDeleted);
                    if (result.ChartSummariesDeleted > 0) store.AddCounter("retention-chart-hourly-deleted", result.ChartSummariesDeleted);
                    if (result.CoverageSessionsDeleted > 0) store.AddCounter("retention-coverage-deleted", result.CoverageSessionsDeleted);
                    if (result.SleepPeriodsDeleted > 0) store.AddCounter("retention-sleep-periods-deleted", result.SleepPeriodsDeleted);
                    if (result.MayHaveMore(50_000)) await Task.Delay(100, cancellationToken);
                } while (result.MayHaveMore(50_000) && !cancellationToken.IsCancellationRequested);
                if (store.CompactIfBeneficial()) store.AddCounter("retention-compactions", 1);
                store.MarkRetentionMaintenanceCompleted(DateTimeOffset.UtcNow);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch
            {
                try { store.AddCounter("retention-maintenance-failure", 1); }
                catch { /* The original store failure remains visible through health/startup diagnostics. */ }
            }

            try { await Task.Delay(TimeSpan.FromHours(24), cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private static void WriteStartupFailure(Exception exception)
    {
        try
        {
            var root = Path.Combine(AppContext.BaseDirectory, "data");
            Directory.CreateDirectory(root);
            File.WriteAllText(Path.Combine(root, "startup-error.txt"),
                $"{DateTimeOffset.UtcNow:O} {exception.GetType().Name}: {exception.Message}");
        }
        catch { }
    }

    private static string ReadAllowedUserSid()
    {
        using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\EgressView\Agent", writable: false);
        var sid = key?.GetValue("AllowedUserSid") as string;
        if (string.IsNullOrWhiteSpace(sid)) throw new InvalidOperationException("IPC allowed user SID is not configured.");
        _ = new System.Security.Principal.SecurityIdentifier(sid);
        return sid;
    }

    private static void WriteEventLogFailure(Exception exception)
    {
        try
        {
            System.Diagnostics.EventLog.WriteEntry("EgressViewAgent",
                $"EgressView Agent stopped collecting. {exception.GetType().Name}: {exception.Message}",
                System.Diagnostics.EventLogEntryType.Error, 1001);
        }
        catch { }
    }
}
