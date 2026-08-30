using System.ServiceProcess;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal static class Program
{
    private static int Main(string[] args)
    {
        if (args.Contains("--console", StringComparer.OrdinalIgnoreCase))
            return RunConsoleAsync(args).GetAwaiter().GetResult();
        if (args.Contains("--inspect", StringComparer.OrdinalIgnoreCase))
            return Inspect(args);
        ServiceBase.Run(new AgentWindowsService());
        return 0;
    }

    private static int Inspect(string[] args)
    {
        var database = Argument(args, "--data") ?? throw new ArgumentException("--data is required");
        using var store = new ObservationStore(database);
        Console.WriteLine(DiagnosticsReport.Create(
            new CollectorSnapshot("stopped", 0, 0, 0, 0, null, null, 0), store, "0.1.0-dev"));
        return 0;
    }

    private static async Task<int> RunConsoleAsync(string[] args)
    {
        var database = Argument(args, "--data") ?? Path.Combine(AppContext.BaseDirectory, "data", "egressview-agent.db");
        var seconds = int.TryParse(Argument(args, "--seconds"), out var parsed) ? parsed : 15;
        using var store = new ObservationStore(database);
        var snapshot = StartupSnapshot.Capture();
        var coverageId = store.BeginCoverage(snapshot, DateTimeOffset.UtcNow);
        await using var pipeline = new ObservationPipeline(store);
        await using var collector = new EtwNetworkCollector(pipeline);
        try { collector.Start(); }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 2; }
        await Task.WhenAny(Task.Delay(TimeSpan.FromSeconds(seconds)), pipeline.Completion);
        var snapshotAfterRun = collector.Enrich(pipeline.Snapshot());
        if (snapshotAfterRun.PersistenceFailures == 0) store.EndCoverage(coverageId, DateTimeOffset.UtcNow);
        var diagnostics = DiagnosticsReport.Create(snapshotAfterRun, store, "0.1.0-dev");
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

    public AgentWindowsService() => ServiceName = "EgressViewAgent";

    protected override void OnStart(string[] args)
    {
        stop = new CancellationTokenSource();
        worker = Task.Run(async () =>
        {
            try { await RunAsync(stop.Token); }
            catch (Exception ex)
            {
                WriteStartupFailure(ex);
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

    private static async Task RunAsync(CancellationToken cancellationToken)
    {
        var root = Path.Combine(AppContext.BaseDirectory, "data");
        Directory.CreateDirectory(root);
        using var store = new ObservationStore(Path.Combine(root, "egressview-agent.db"));
        var snapshot = StartupSnapshot.Capture();
        var coverageId = store.BeginCoverage(snapshot, DateTimeOffset.UtcNow);
        await using var pipeline = new ObservationPipeline(store);
        await using var collector = new EtwNetworkCollector(pipeline);
        collector.Start();
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
        store.EndCoverage(coverageId, DateTimeOffset.UtcNow);
        File.WriteAllText(Path.Combine(root, "diagnostics.json"),
            DiagnosticsReport.Create(collector.Enrich(pipeline.Snapshot()), store, "0.1.0-dev"));
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
}
