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
        if (args.Contains("--console", StringComparer.OrdinalIgnoreCase))
            return RunConsoleAsync(args).GetAwaiter().GetResult();
        if (args.Contains("--inspect", StringComparer.OrdinalIgnoreCase))
            return Inspect(args);
        if (args.Contains("--diagnostics-bundle", StringComparer.OrdinalIgnoreCase))
            return ExportBundle(args);
        if (args.Contains("--ipc-request", StringComparer.OrdinalIgnoreCase))
            return IpcRequest(args);
        ServiceBase.Run(new AgentWindowsService());
        return 0;
    }

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

    private static int ExportBundle(string[] args)
    {
        var database = Argument(args, "--data") ?? throw new ArgumentException("--data is required");
        var destination = Argument(args, "--diagnostics-bundle") ?? throw new ArgumentException("--diagnostics-bundle path is required");
        using var store = new ObservationStore(database);
        var report = DiagnosticsReport.Create(new CollectorSnapshot("stopped", 0, 0, 0, 0, null, null, 0), store, "0.1.0-dev");
        DiagnosticsBundle.Create(destination, report);
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
        await using var pipeline = new ObservationPipeline(store, deliveryEnabled: () => store.DeliveryEnabled);
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

    private static async Task RunAsync(CancellationToken cancellationToken)
    {
        var root = Path.Combine(AppContext.BaseDirectory, "data");
        Directory.CreateDirectory(root);
        using var store = new ObservationStore(Path.Combine(root, "egressview-agent.db"));
        var snapshot = StartupSnapshot.Capture();
        var coverageId = store.BeginCoverage(snapshot, DateTimeOffset.UtcNow);
        await using var pipeline = new ObservationPipeline(store, deliveryEnabled: () => store.DeliveryEnabled);
        await using var collector = new EtwNetworkCollector(pipeline);
        collector.Start();
        var credentialStore = new WindowsCredentialStore();
        await using var ipc = new AgentIpcServer(store, () => collector.Enrich(pipeline.Snapshot()), ReadAllowedUserSid(), credentialStore);
        ipc.Start();
        var delivery = RunDeliveryAsync(store, credentialStore, cancellationToken);
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
        await delivery;
        File.WriteAllText(Path.Combine(root, "diagnostics.json"),
            DiagnosticsReport.Create(collector.Enrich(pipeline.Snapshot()), store, "0.1.0-dev"));
    }

    private static async Task RunDeliveryAsync(ObservationStore store, WindowsCredentialStore credentials, CancellationToken cancellationToken)
    {
        var sender = new DeliverySender();
        var retry = TimeSpan.FromSeconds(5);
        while (!cancellationToken.IsCancellationRequested)
        {
            var delay = TimeSpan.FromSeconds(5);
            try
            {
                if (store.DeliveryEnabled && credentials.Load() is { } credential)
                {
                    var result = await sender.SendNextAsync(store, credential,
                        new(Environment.MachineName, "windows", Environment.OSVersion.VersionString, "0.1.0-dev"), cancellationToken);
                    delay = result.Kind switch
                    {
                        DeliveryAttemptKind.Acknowledged => TimeSpan.Zero,
                        DeliveryAttemptKind.Empty => TimeSpan.FromSeconds(15),
                        DeliveryAttemptKind.RateLimited => result.RetryAfter ?? TimeSpan.FromMinutes(1),
                        DeliveryAttemptKind.AuthorizationRequired => TimeSpan.FromMinutes(5),
                        _ => retry,
                    };
                    retry = result.Kind is DeliveryAttemptKind.Retryable or DeliveryAttemptKind.Rejected or DeliveryAttemptKind.InvalidAcknowledgement
                        ? TimeSpan.FromSeconds(Math.Min(retry.TotalSeconds * 2, 300)) : TimeSpan.FromSeconds(5);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch { delay = retry; retry = TimeSpan.FromSeconds(Math.Min(retry.TotalSeconds * 2, 300)); }
            if (delay > TimeSpan.Zero) try { await Task.Delay(delay, cancellationToken); }
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
