using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class AgentIpcServer(ObservationStore store, Func<CollectorSnapshot> snapshot, string allowedSid,
    WindowsCredentialStore credentialStore, Func<bool> monitoringEnabled, Func<bool, bool> setMonitoringEnabled,
    Func<bool> readsHostnames, Func<bool, bool> setReadsHostnames,
    DeliveryController delivery, EnrichmentController enrichment) : IAsyncDisposable
{
    public const string PipeName = "egressview-agent-v1";

    /// How many callers can be connected at once (P3-140).
    ///
    /// It was one, and not by decision: the first version of this server was
    /// a loop that created a pipe, served one request, closed it and made the
    /// next, and the one was that loop's shape. Nothing recorded a reason. The
    /// cost was measured on 2026-09-24: the 30-day analysis takes 8.8 seconds,
    /// and a status request made during it could not even connect -- it
    /// failed after five seconds, and the window, which asks every five,
    /// showed "cannot read state" whenever someone looked at a week or a
    /// month. The Agent was not broken; it was busy, and said so in the words
    /// for broken.
    ///
    /// Four, because the window asks for a handful of things at once when a
    /// view opens -- the status, the analysis, the globe, the log -- and more
    /// than that would only queue on the store's lock anyway.
    public const int Listeners = 4;

    private readonly CancellationTokenSource stop = new();
    private Task[] loops = [];
    private readonly AgentUninstallClient uninstallClient = new();

    /// NT SERVICE\EgressViewAgent -- the one identity allowed to add
    /// instances of this pipe. See BuildSecurity.
    private readonly SecurityIdentifier serviceSid = ServiceIdentity.Sid();

    /// How many listeners actually run: four when this process carries the
    /// service's own SID, one when it does not.
    ///
    /// Without that SID no listener after the first can create its instance,
    /// and 0.1.125 showed what happens then: three listeners failing ten
    /// times a second each, every failure a counter written to the database,
    /// for as long as the service ran. A service installed before the SID
    /// type was set, or by the development script, serves one caller at a
    /// time as it always did, and says so once.
    public int ActiveListeners { get; private set; }

    public void Start()
    {
        ActiveListeners = ServiceIdentity.CarriesOwnSid(serviceSid) ? Listeners : 1;
        if (ActiveListeners == 1)
            try { store.SetCounter("ipc-single-listener-no-service-sid", 1); } catch { }
        loops = Enumerable.Range(0, ActiveListeners).Select(_ => Task.Run(ServeAsync)).ToArray();
    }

    /// <param name="server">
    /// The identity that creates the pipe's instances: the service's own SID.
    ///
    /// It has to be named. Creating a second instance of a pipe opens the
    /// first one -- for reading and writing, not only with CreateNewInstance
    /// -- so the creator needs all three on the first instance's rules.
    /// Measured, with the window's rule on a SID the creator is certainly not:
    /// CreateNewInstance alone is refused, CreateNewInstance with read, write
    /// and synchronize is not.
    ///
    /// 0.1.125 granted CreateNewInstance alone, to the account the process ran
    /// as. Its test gave the window's rule and the server's the same SID, so
    /// the window's read and write covered the server too, the test passed,
    /// and the installed service failed every listener after the first.
    ///
    /// Not LocalService, which is what the service runs as. Read and write on
    /// this pipe is the whole IPC -- history export, enrolment, deleting
    /// history -- and LocalService is shared by other Windows services; giving
    /// it that would have widened who can talk to the Agent from the signed-in
    /// user to every LocalService process. NT SERVICE\EgressViewAgent is in
    /// this service's token and no other, once the installer sets its SID
    /// type to unrestricted.
    ///
    /// And it narrows who can stand in for this server rather than widening
    /// it: with one listener there was no pipe at all while a request was
    /// being served, and anyone could create one of this name in that gap.
    /// With several there is always an instance, and adding one takes these
    /// rights, which only LocalSystem and this service have.
    /// </param>
    internal static PipeSecurity BuildSecurity(string allowedSid, SecurityIdentifier server)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowedSid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(server,
            PipeAccessRights.CreateNewInstance | PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return security;
    }

    private Task ServeAsync() => RunResilientLoopAsync(ServeOneAsync, () =>
    {
        try { store.AddCounter("ipc-connection-failure", 1); } catch { }
    }, stop.Token);

    /// The window's run id, held here because the window cannot hold one.
    private long uiRunId;
    // Requests are served concurrently now; the window's begin and end can
    // arrive on different listeners.
    private readonly object uiRunGate = new();

    private void RecordUiRun(string stage, string? fault)
    {
        lock (uiRunGate)
        {
            switch (stage)
            {
                case "begin": uiRunId = store.BeginRun(RunComponent.Ui, DiagnosticsReport.CurrentVersion); break;
                case "end" when uiRunId != 0: store.EndRun(uiRunId); uiRunId = 0; break;
                case "fault" when uiRunId != 0: store.FaultRun(uiRunId, fault ?? "Unknown"); uiRunId = 0; break;
            }
        }
    }

    private async Task ServeOneAsync(CancellationToken cancellationToken)
    {
        await using var pipe = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, Listeners, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 4096, 4096, BuildSecurity(allowedSid, serviceSid));
        await pipe.WaitForConnectionAsync(cancellationToken);
        using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
        await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        var line = await reader.ReadLineAsync(cancellationToken);
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
        cutoff => store.DeleteLocalHistory(cutoff, DateTimeOffset.UtcNow), Diagnostics, PrepareUninstall, CountryHistory,
        store.ReadRecentObservations, store.ReadLogSnapshot, store.ReadObservationsSince, RecordUiRun, setReadsHostnames,
        enrichment.SetPublicFeedsEnabled, SetCountryTableAccount, enrichment.SetCountryTableEnabled,
        () => _ = enrichment.FetchPublicFeedsOnceAsync(CancellationToken.None),
        enrichment.SetLookupSource));
    }

    /// Either the text of a GeoIP.conf, or nothing at all to withdraw.
    private bool SetCountryTableAccount(string? configuration)
    {
        if (configuration is null) { enrichment.ClearMaxMindAccount(); return true; }
        return enrichment.SetMaxMindAccountFromConfiguration(configuration);
    }

    internal static async Task RunResilientLoopAsync(Func<CancellationToken, Task> serveOne, Action connectionFailed,
        CancellationToken cancellationToken, TimeSpan? retryDelay = null)
    {
        var consecutiveFailures = 0;
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await serveOne(cancellationToken);
                consecutiveFailures = 0;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch (Exception)
            {
                // A client can legitimately disappear after its timeout (for example
                // during sign-in while a large database is warming up). A broken read
                // or write must end only that connection, never the permanent listener.
                try { connectionFailed(); } catch { }
                consecutiveFailures++;
                try { await Task.Delay(RetryDelay(retryDelay ?? TimeSpan.FromMilliseconds(100), consecutiveFailures), cancellationToken); }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            }
        }
    }

    /// Longer each time the same listener fails again, up to half a minute.
    ///
    /// One client that disappears is one failure, retried at once. A listener
    /// that can never succeed -- 0.1.125's, unable to create its instance --
    /// failed ten times a second for as long as the service ran, and wrote a
    /// counter to the database each time. Backing off bounds any such cause,
    /// including ones nobody has found yet, to one failure per half minute.
    internal static TimeSpan RetryDelay(TimeSpan first, int consecutiveFailures)
    {
        var cap = TimeSpan.FromSeconds(30);
        if (consecutiveFailures <= 1 || first <= TimeSpan.Zero) return first < cap ? first : cap;
        var doublings = Math.Min(consecutiveFailures - 1, 16);
        var delay = first * Math.Pow(2, doublings);
        return delay < cap ? delay : cap;
    }

    private readonly StatusFallback statusFallback = new();

    private string Status() => statusFallback.Get(() =>
        DiagnosticsReport.CreateStatus(snapshot(), store, DiagnosticsReport.CurrentVersion, monitoringEnabled(), readsHostnames()));
    /// Reports the last full read rather than performing one. Performing it
    /// here held the lock for thirty seconds and the pipe serves one caller at
    /// a time, so saving a bundle made the window show "status unavailable"
    /// for the whole of it.
    private string Diagnostics() => DiagnosticsReport.Create(snapshot(), store, DiagnosticsReport.CurrentVersion, monitoringEnabled(), verifyIntegrity: false,
        reportChannel: "authenticated-named-pipe", capabilityStatus: delivery.CapabilityStatus,
        deliveryRuntime: delivery.Status);
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
        foreach (var loop in loops)
            try { await loop; } catch (OperationCanceledException) { }
        uninstallClient.Dispose();
        stop.Dispose();
    }
}
