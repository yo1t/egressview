using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class AgentIpcServer(ObservationStore store, Func<CollectorSnapshot> snapshot, string allowedSid,
    WindowsCredentialStore credentialStore, Func<bool> monitoringEnabled, Func<bool, bool> setMonitoringEnabled,
    DeliveryController delivery, EnrichmentController enrichment) : IAsyncDisposable
{
    public const string PipeName = "egressview-agent-v1";
    private readonly CancellationTokenSource stop = new();
    private Task? loop;
    private readonly AgentUninstallClient uninstallClient = new();

    public void Start() => loop = Task.Run(ServeAsync);

    internal static PipeSecurity BuildSecurity(string allowedSid)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowedSid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return security;
    }

    private async Task ServeAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            await using var pipe = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 4096, 4096, BuildSecurity(allowedSid));
            try { await pipe.WaitForConnectionAsync(stop.Token); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            var line = await reader.ReadLineAsync(stop.Token);
            if (line is not null) await writer.WriteLineAsync(IpcProtocol.Handle(line, Status, Summary, credential =>
                {
                    credentialStore.Save(credential);
                    delivery.SettingsChanged();
                },
                enabled =>
                {
                    if (enabled && credentialStore.Load() is null)
                        throw new InvalidOperationException("Enrollment is required before delivery can be enabled.");
                    store.DeliveryEnabled = enabled;
                    delivery.SettingsChanged();
                }, store.ReadRecentFlows, Globe, Analysis, Threats, setMonitoringEnabled, DeliveryStatus, delivery.RequestNow,
                enrichment.Status, enrichment.RequestNow, HistoryStatus, SetHistoryRetention, store.ReadHistoryForExport,
                cutoff => store.DeleteLocalHistory(cutoff, DateTimeOffset.UtcNow), Diagnostics, PrepareUninstall, CountryHistory));
        }
    }

    private string Status() => DiagnosticsReport.Create(snapshot(), store, DiagnosticsReport.CurrentVersion, monitoringEnabled(), capabilityStatus: delivery.CapabilityStatus);
    private string Diagnostics() => DiagnosticsReport.Create(snapshot(), store, DiagnosticsReport.CurrentVersion, monitoringEnabled(), verifyIntegrity: true,
        reportChannel: "authenticated-named-pipe", capabilityStatus: delivery.CapabilityStatus);
    private IReadOnlyList<HourlySummary> Summary(int days) => store.ReadHourlySummary(DateTimeOffset.UtcNow.AddDays(-days), DateTimeOffset.UtcNow);
    private IReadOnlyList<GlobePoint> Globe(int minutes) => store.ReadGlobePoints(DateTimeOffset.UtcNow.AddMinutes(-minutes), DateTimeOffset.UtcNow);
    private IReadOnlyList<CountryHistoryRow> CountryHistory(int? minutes)
    {
        var now = DateTimeOffset.UtcNow;
        return minutes is { } value ? store.ReadCountryHistory(now.AddMinutes(-value), now) : store.ReadCountryHistory();
    }
    private PeriodAnalysis Analysis(int minutes, int offsetMinutes)
    {
        var to = DateTimeOffset.UtcNow.AddMinutes(-offsetMinutes);
        return store.ReadPeriodAnalysis(to.AddMinutes(-minutes), to);
    }
    private ThreatReport Threats(int minutes) => store.ReadThreatReport(DateTimeOffset.UtcNow.AddMinutes(-minutes), DateTimeOffset.UtcNow);
    private string DeliveryStatus()
    {
        var credential = credentialStore.Load();
        var queue = store.ReadDeliveryStatus();
        var runtime = delivery.Status;
        return System.Text.Json.JsonSerializer.Serialize(new
        {
            enrolled = credential is not null,
            hub = credential?.HubUrl.GetLeftPart(UriPartial.Authority),
            enabled = store.DeliveryEnabled,
            pending = queue.Pending,
            oldestPendingAt = queue.OldestPendingAt,
            lastAcknowledgedAt = queue.LastAcknowledgedAt,
            contractRejected = queue.ContractRejected,
            queueOverflow = queue.QueueOverflow,
            state = runtime.State,
            lastAttemptAt = runtime.LastAttemptAt,
            nextRetryAt = runtime.NextRetryAt,
            lastFailure = runtime.LastFailure,
            lastFailureAt = runtime.LastFailureAt,
            lastStatusCode = runtime.LastStatusCode,
            capability = delivery.CapabilityStatus,
        });
    }

    private LocalHistoryStatus HistoryStatus() => store.ReadLocalHistoryStatus(DateTimeOffset.UtcNow);

    private AgentUninstallResult PrepareUninstall(bool removeHistory, bool continueWithoutRevocation)
    {
        setMonitoringEnabled(false);
        delivery.PauseAndWait();
        var credential = credentialStore.Load();
        var revoked = false;
        if (credential is not null && !continueWithoutRevocation)
        {
            uninstallClient.RevokeAsync(credential).GetAwaiter().GetResult();
            revoked = true;
        }
        var result = store.CompleteUninstallPreparation(removeHistory, revoked, credential is not null && continueWithoutRevocation, DateTimeOffset.UtcNow);
        credentialStore.Delete();
        return result;
    }

    private LocalHistoryStatus SetHistoryRetention(int days)
    {
        store.SetRetentionDays(days);
        RetentionMaintenanceResult result;
        do { result = store.PruneRetentionBatch(DateTimeOffset.UtcNow); }
        while (result.MayHaveMore(50_000));
        store.MarkRetentionMaintenanceCompleted(DateTimeOffset.UtcNow);
        return HistoryStatus();
    }

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (loop is not null) try { await loop; } catch (OperationCanceledException) { }
        uninstallClient.Dispose();
        stop.Dispose();
    }
}
