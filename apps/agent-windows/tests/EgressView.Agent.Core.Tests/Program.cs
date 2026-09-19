using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using EgressView.Agent.Core;

var directory = Path.Combine(Path.GetTempPath(), $"egressview-agent-tests-{Guid.NewGuid():N}");
Directory.CreateDirectory(directory);
var database = Path.Combine(directory, "agent.db");
var windowsRoot = FindWindowsRoot(Directory.GetCurrentDirectory());

// Shared product language is defined by the Mac UI. Keep the explicitly
// reviewed cross-platform terms synchronized without constraining Windows-only
// controls (ETW, Service, MSI, UAC, tray, and so on).
var sharedWording = new (string WindowsKey, string MacEnglish)[]
{
    ("Connections", "Connections"), ("DeleteAllConversations", "Delete all"),
    ("DeleteBefore", "Delete records from before"), ("Destinations", "Destinations"),
    ("Hub", "Hub"), ("HubDelivery", "Hub delivery"), ("Insights", "Insights"),
    ("Last30Days", "Last 30 days"), ("Last7Days", "Last 7 days"),
    ("Model", "Model"), ("Monitoring", "Monitoring"),
    ("NoNotifications", "No notifications have been attempted yet."),
    ("PacketPrivacy", "Packet contents are never collected."),
    ("Port", "Port"), ("Provider", "Provider"), ("Retention", "Retention"),
    ("RibbonBytes", "Ribbon width is data volume"),
    ("RibbonConnections", "Ribbon width is the number of connections"),
    ("SaveCopyBeforeDeleting", "Save a copy before deleting"),
    ("SaveTest", "Save and test"), ("SuppressedToday", "Suppressed today"),
    ("TopApplications", "Top applications"),
    ("WhenTraffic", "When traffic happened"),
    ("WhichAppWhere", "Which application went where"),
    ("NotificationsToday", "Notifications today"),
    ("ClearHistory", "Clear notification history"),
    ("ThreatAlerts", "New threat matches"),
    ("ThreatIntelAlerts", "Threat information changes"),
    ("NotificationsAfterChecks", "After category and cooldown checks"),
    ("NotificationsDailyLimitOnly", "Daily limit only; duplicates are not counted"),
    ("NoNotificationAttempts", "No notifications have been attempted yet."),
    ("NotificationKindHubDelivery", "Hub delivery")
};
var resourceRoot = Path.Combine(windowsRoot, "src", "EgressView.Agent.Ui", "Resources");
var windowsEnglish = XDocument.Load(Path.Combine(resourceRoot, "Strings.en.xaml"));
var windowsJapanese = XDocument.Load(Path.Combine(resourceRoot, "Strings.ja.xaml"));
var macJapaneseSource = File.ReadAllText(Path.Combine(windowsRoot, "..", "agent-macos", "Xcode", "Host", "ja.lproj", "Localizable.strings"));
var macJapanese = new Dictionary<string, string>(StringComparer.Ordinal);
foreach (Match match in Regex.Matches(macJapaneseSource, "^\\s*\"(?<key>[^\"]+)\"\\s*=\\s*\"(?<value>.*)\";\\s*$", RegexOptions.Multiline))
    macJapanese[match.Groups["key"].Value] = match.Groups["value"].Value;
static string SharedResource(XDocument document, string key) => document.Descendants()
    .Single(element => element.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml"))?.Value == key).Value;
foreach (var (windowsKey, macEnglish) in sharedWording)
{
    Assert(SharedResource(windowsEnglish, windowsKey) == macEnglish,
        $"Shared wording English drifted: {windowsKey}");
    Assert(macJapanese.TryGetValue(macEnglish, out var macValue) &&
        SharedResource(windowsJapanese, windowsKey) == macValue,
        $"Shared wording Japanese drifted: {windowsKey}");
}
// Check every exact shared English string, not only the historical review list.
// These two keys have different contexts: a Windows language preference and
// the ETW collection method are not macOS system settings or traffic source.
var contextualExceptions = new HashSet<string>(StringComparer.Ordinal)
{
    "SystemDefault", "LogSource"
};
foreach (var entry in windowsEnglish.Descendants().Where(element => element.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml")) is not null))
{
    var key = entry.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml"))!.Value;
    if (contextualExceptions.Contains(key) || !macJapanese.TryGetValue(entry.Value, out var expectedJapanese))
        continue;
    Assert(SharedResource(windowsJapanese, key) == expectedJapanese,
        $"Shared English has different Japanese wording: {key}");
}

static string FindWindowsRoot(string start)
{
    for (var path = start; path is not null; path = Directory.GetParent(path)?.FullName)
        foreach (var candidate in new[] { path, Path.Combine(path, "apps", "agent-windows") })
            if (File.Exists(Path.Combine(candidate, "src", "EgressView.Agent.Ui", "Resources", "Strings.en.xaml")))
                return candidate;
    throw new DirectoryNotFoundException("Windows Agent source root was not found.");
}

try
{
    var monitoringTracker = new MonitoringStatusTracker();
    Assert(monitoringTracker.Current.Kind == MonitoringPresentationKind.Checking && monitoringTracker.Current.LastConfirmedAt is null,
        "monitoring presentation starts as checking rather than reporting a false problem");
    var healthConfirmedAt = new DateTimeOffset(2026, 9, 11, 0, 0, 0, TimeSpan.Zero);
    monitoringTracker.Confirm(true, true, healthConfirmedAt);
    var unavailableHealth = monitoringTracker.MarkUnavailable();
    Assert(unavailableHealth.Kind == MonitoringPresentationKind.Unavailable && unavailableHealth.LastConfirmedAt == healthConfirmedAt &&
        unavailableHealth.LastConfirmedEnabled == true && unavailableHealth.LastConfirmedHealthy == true,
        "an IPC failure is distinct from collector failure and retains the last confirmed monitoring state");
    var degradedHealth = monitoringTracker.Confirm(true, false, healthConfirmedAt.AddMinutes(1), "etw-session-stopped", "Restart the service");
    Assert(degradedHealth.Kind == MonitoringPresentationKind.NeedsAttention && degradedHealth.IssueCode == "etw-session-stopped" &&
        degradedHealth.IssueAction == "Restart the service",
        "a confirmed collector problem remains actionable and distinct from status unavailability");
    Assert(monitoringTracker.Confirm(false, false, healthConfirmedAt.AddMinutes(2)).Kind == MonitoringPresentationKind.Stopped,
        "an intentional monitoring stop is not presented as a fault");
    Assert(AgentIpcClient.RequestTimeout == TimeSpan.FromSeconds(15),
        "IPC requests bound the complete request and response lifetime");
    Assert(EtwConnectionEvents.Classify("TcpConnectionattempted") == EtwConnectionEventKind.Attempted &&
        EtwConnectionEvents.Classify("TcpConnectionaccepted") == EtwConnectionEventKind.Accepted &&
        EtwConnectionEvents.Classify("TcpDisconnectissued") == EtwConnectionEventKind.Disconnect &&
        EtwConnectionEvents.Classify("TcpClose") == EtwConnectionEventKind.Close &&
        EtwConnectionEvents.Classify("TcpDatasent") == EtwConnectionEventKind.Other,
        "ETW connection lifecycle event counters distinguish starts and endings from data events");

    using (var ipcLoopStop = new CancellationTokenSource())
    {
        var attempts = 0;
        var failures = 0;
        await EgressView.Agent.Service.AgentIpcServer.RunResilientLoopAsync(_ =>
        {
            attempts++;
            if (attempts == 1) throw new IOException("client disconnected before response");
            ipcLoopStop.Cancel();
            throw new OperationCanceledException(ipcLoopStop.Token);
        }, () => failures++, ipcLoopStop.Token, TimeSpan.Zero);
        Assert(attempts == 2 && failures == 1,
            "a timed-out or disconnected UI ends only its IPC connection and the listener accepts the next client");
    }

    using (var statusStore = new ObservationStore(Path.Combine(directory, "status.db")))
    {
        var statusCoverage = statusStore.BeginCoverage(StartupSnapshot.Capture(), healthConfirmedAt);
        var statusJson = DiagnosticsReport.CreateStatus(
            new CollectorSnapshot("healthy", 10, 10, 0, 0, healthConfirmedAt, healthConfirmedAt, 64),
            statusStore, "9.8.7");
        using var statusDocument = JsonDocument.Parse(statusJson);
        var statusRoot = statusDocument.RootElement;
        Assert(statusRoot.GetProperty("health").GetProperty("status").GetString() == "healthy" &&
            statusRoot.GetProperty("coverage").GetProperty("active").GetInt64() == 1 &&
            statusRoot.GetProperty("deliveryEnabled").ValueKind is JsonValueKind.True or JsonValueKind.False,
            "the polled status retains the UI health, coverage, and delivery contract");
        Assert(!statusRoot.TryGetProperty("database", out _) && !statusRoot.TryGetProperty("flows", out _) &&
            !statusJson.Contains("observationCount", StringComparison.Ordinal),
            "the polled status never scans history-sized diagnostic tables");
        statusStore.EndCoverage(statusCoverage, healthConfirmedAt.AddMinutes(1));
    }

    Assert(SankeyLabelLayout.NamedCapacity(340, 14) > SankeyLabelLayout.NamedCapacity(170, 14),
        "a taller Sankey names more rows instead of retaining a fixed seven-item ceiling");
    static double MonospaceMeasure(string value) => value.Length;
    var similarLabels = SankeyLabelLayout.FitDistinct(
        ["api.cluster-east.example.net", "api.cluster-west.example.net", "2606:4700:4408::ac40:9bd1", "2606:4700:4408::ac40:9bd2"],
        [18, 18, 18, 18], MonospaceMeasure);
    Assert(similarLabels.Distinct(StringComparer.Ordinal).Count() == similarLabels.Count &&
        similarLabels.All(label => MonospaceMeasure(label) <= 18 && label.Count(character => character == '…') <= 1),
        "similar hostnames and IPv6 addresses remain distinct, fit once, and never receive a double ellipsis");
    var fullLabels = SankeyLabelLayout.FitDistinct(["chrome", "codex"], [20, 20], MonospaceMeasure);
    Assert(fullLabels.SequenceEqual(["chrome", "codex"]), "labels that fit are not abbreviated");

    var byteSpike = Enumerable.Repeat(30_000_000L, 23).ToList();
    byteSpike.Insert(3, 1_710_000_000L);
    var byteAxis = TimelineAxisScale.Fit(byteSpike, true);
    Assert(byteAxis.HasClipping && byteAxis.Clipped.SequenceEqual([3]) && byteAxis.Peak == 1_710_000_000L &&
        byteAxis.Top > 30_000_000 && byteAxis.Top < 171_000_000,
        "one byte spike is marked and no longer flattens the rest of the period");
    Assert(!TimelineAxisScale.Fit([100, 250, 400, 180, 320, 90, 500, 210], true).HasClipping,
        "ordinary byte variation keeps its real maximum");
    Assert(TimelineAxisScale.Fit([10, 10, 1000, 10, 10, 10, 10, 1000, 10, 10], true).Clipped.SequenceEqual([2, 7]),
        "equal spikes are both marked against the next genuinely lower bucket");
    Assert(TimelineAxisScale.Fit([100, 400], true).HasClipping && !TimelineAxisScale.Fit([100, 399], true).HasClipping,
        "the documented four-times outlier boundary is deterministic");
    Assert(!TimelineAxisScale.Fit([0, 0, 900, 0], true).HasClipping && TimelineAxisScale.Fit([0, 0, 0], true).Top == 0,
        "a lone value and an all-zero period are never falsely clipped");
    Assert(!TimelineAxisScale.Fit([10, 10, 1000], false).HasClipping && TimelineAxisScale.Fit([10, 10, 1000], false).Top == 1000,
        "connection timelines always retain the actual maximum");

    Assert(GlobePresentation.AdvanceLongitude(140, TimeSpan.FromSeconds(2), 6) == 128 &&
        GlobePresentation.AdvanceLongitude(2, TimeSpan.FromSeconds(1), 6) == 356,
        "the Windows globe turns eastward with the same decreasing centre longitude and wraparound as Mac");
    Assert(EqualEarthProjection.AspectRatio is > 2 and < 2.1 &&
        EqualEarthProjection.Project(0, 0) is (0.5, 0.5) &&
        EqualEarthProjection.Project(0, 180).X is > 0.99 and <= 1,
        "Equal Earth keeps the whole world on one equal-area map without a hidden hemisphere");
    var seamPieces = EqualEarthProjection.Split([(10, 179), (15, -179), (5, -178), (10, 179)]);
    Assert(seamPieces.Count >= 2 && seamPieces.All(piece => piece.Zip(piece.Skip(1))
        .All(pair => Math.Abs(pair.First.Lon - pair.Second.Lon) <= 180)),
        "rings crossing the antimeridian do not draw a line across the map");
    var glowAt = new DateTimeOffset(2026, 9, 13, 0, 0, 0, TimeSpan.Zero);
    Assert(CountryGlow.Intensity(glowAt, glowAt) == 1 &&
        Math.Abs(CountryGlow.Intensity(glowAt, glowAt.AddSeconds(3)) - 0.5) < 0.000001 &&
        CountryGlow.Intensity(glowAt, glowAt.AddSeconds(6)) == 0 &&
        CountryGlow.Intensity(glowAt, glowAt.AddSeconds(7)) == 0,
        "new-country glow follows a six-second cosine fade and stops drawing after expiry");

    var relaunchEncoded = UpdateRelaunchCommand.BuildEncodedPowerShell(4242, @"C:\Program Files\EgressView Agent\ui\EgressView.Agent.Ui.exe", "0.1.37", TimeSpan.FromMinutes(15));
    var relaunchScript = Encoding.Unicode.GetString(Convert.FromBase64String(relaunchEncoded));
    Assert(relaunchScript.Contains("Get-Process -Id $oldProcessId", StringComparison.Ordinal) &&
        relaunchScript.Contains("ProductVersion", StringComparison.Ordinal) && relaunchScript.Contains("--tray", StringComparison.Ordinal) &&
        relaunchScript.Contains("0.1.37", StringComparison.Ordinal),
        "the unelevated update watcher waits for the old UI and the expected installed version before restoring the tray");
    try
    {
        _ = UpdateRelaunchCommand.BuildEncodedPowerShell(1, @"C:\agent.exe", "1.0'; Stop-Process -Name explorer; #", TimeSpan.FromMinutes(15));
        throw new InvalidOperationException("FAILED: unsafe update version reached the relaunch script");
    }
    catch (ArgumentException) { }

    var portableSettings = new AgentSettingsFile(1, "japanese", true, true, false, false, true, true, 12, 5, 360,
        "bytes", "name", "countries", 30, true, "fast");
    var portableBytes = AgentSettingsFile.Encode(portableSettings);
    var portableText = Encoding.UTF8.GetString(portableBytes);
    Assert(portableText.Contains("\"version\"", StringComparison.Ordinal) && portableText.Contains("\"retentionDays\"", StringComparison.Ordinal) &&
        !portableText.Contains("credential", StringComparison.OrdinalIgnoreCase) && !portableText.Contains("hubUrl", StringComparison.OrdinalIgnoreCase) &&
        !portableText.Contains("apiKey", StringComparison.OrdinalIgnoreCase) && !portableText.Contains("startup", StringComparison.OrdinalIgnoreCase) &&
        !portableText.Contains("lookup", StringComparison.OrdinalIgnoreCase),
        "portable settings are readable and cannot carry machine identity, secrets, startup, or external lookup consent");
    var forwardSettings = AgentSettingsFile.Decode(Encoding.UTF8.GetBytes("""{"version":1,"language":"english","retentionDays":7,"futureField":{"enabled":true}}"""));
    Assert(forwardSettings.Language == "english" && forwardSettings.RetentionDays == 7 && AgentSettingsFile.PresentFields(forwardSettings).Count == 2,
        "settings import accepts the shared Mac field names and ignores unknown future fields");
    Assert(portableText.Contains("\"globeSpinSpeed\": \"fast\"", StringComparison.Ordinal),
        "portable settings keep rotation speed distinct from frame rate");
    foreach (var invalid in new[] { "{", "{\"version\":2}", "{\"version\":1,\"globeFrameRate\":99}", "{\"version\":1,\"globeSpinSpeed\":\"turbo\"}", "{\"version\":1,\"retentionDays\":45}" })
    {
        try { AgentSettingsFile.Decode(Encoding.UTF8.GetBytes(invalid)); throw new InvalidOperationException("FAILED: invalid settings file was accepted"); }
        catch (InvalidDataException) { }
    }
    Assert(AgentSettingsFile.SuggestedFileName(new DateTimeOffset(2026, 9, 10, 1, 2, 3, TimeSpan.Zero)) == "egressview-agent-settings-20260910-010203.json",
        "portable settings use a deterministic UTC file name");

    Assert(AgentReleaseKey.MatchesPublishedFingerprint, "the embedded release key matches its published SPKI fingerprint");
    Assert(AgentSemanticVersion.TryParse("1.2.3", out var stableVersion) &&
        AgentSemanticVersion.TryParse("1.2.3-preview", out var previewVersion) && stableVersion.CompareTo(previewVersion) > 0,
        "release versions compare stable builds after prereleases");
    var corruptDiagnosticDatabase = Path.Combine(directory, "corrupt-diagnostics.db");
    File.WriteAllText(corruptDiagnosticDatabase, "not a sqlite database");
    var fallbackBundle = Path.Combine(directory, "fallback-diagnostics.zip");
    Assert(EgressView.Agent.Service.Program.ExportBundle(["--data", corruptDiagnosticDatabase, "--diagnostics-bundle", fallbackBundle]) == 0 && File.Exists(fallbackBundle),
        "the service CLI still creates a limited diagnostic bundle when the database cannot open");
    using (var fallbackArchive = System.IO.Compression.ZipFile.OpenRead(fallbackBundle))
    using (var fallbackReader = new StreamReader(fallbackArchive.GetEntry("diagnostics.json")!.Open()))
        Assert(fallbackReader.ReadToEnd().Contains("reachable\": false", StringComparison.Ordinal),
            "a database startup failure is explicitly classified without exporting database content");
    var updatePayload = Encoding.UTF8.GetBytes("signed-msi-payload");
    var updateHash = Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(updatePayload));
    var updateManifest = JsonSerializer.Serialize(new
    {
        schemaVersion = 1,
        platform = "windows",
        version = "9.8.7",
        releasedAt = DateTimeOffset.UtcNow,
        packages = new[] { new { arch = WindowsAgentUpdateClient.HostArch, packageType = "msi", url = "https://dl.egressview.com/windows/EgressView.msi", sha256 = updateHash, sizeBytes = updatePayload.Length, publisher = "EgressView" } },
    });
    var updateHandler = new UpdateHandler(updateManifest, updatePayload);
    var packageVerifier = new TestPackageVerifier();
    using (var updateClient = new WindowsAgentUpdateClient(updateHandler, verifier: packageVerifier, manifestVerifier: new AcceptManifestVerifier()))
    {
        var decision = await updateClient.CheckAsync("1.0.0", "10.0.26100");
        Assert(decision.Kind == AgentUpdateDecisionKind.UpdateAvailable && decision.Candidate?.Version == "9.8.7",
            "a newer signed Windows release selects the host architecture MSI");
        var verified = await updateClient.DownloadAndVerifyAsync(decision.Candidate!, directory);
        Assert(File.Exists(verified.Path) && verified.Publisher == "EgressView Code Signing" && packageVerifier.Calls == 1,
            "download requires exact size, SHA-256, Authenticode, and publisher verification before becoming installable");
        await updateClient.ReverifyAsync(verified);
        Assert(packageVerifier.Calls == 2, "the verified MSI is hashed and signature-checked again immediately before launch");
        Assert(updateHandler.UserAgents.All(value => value == "EgressViewAgent/1.0.0 (Windows 10.0.26100)") && !updateHandler.SawCookie,
            "update checks disclose only the Agent and Windows versions and never send cookies");
    }

    var uninstallCredential = new AgentCredential(new Uri("https://hub.example/"), Guid.NewGuid(), $"egva_{new string('a', 64)}", DateTimeOffset.UtcNow);
    var uninstallHandler = new UninstallHandler(HttpStatusCode.OK);
    using (var uninstallClient = new AgentUninstallClient(uninstallHandler))
        await uninstallClient.RevokeAsync(uninstallCredential);
    Assert(uninstallHandler.RequestUri?.AbsoluteUri == "https://hub.example/api/agent/registration/revoke" &&
        uninstallHandler.SawBearer && uninstallHandler.ContentBytes == 0,
        "uninstall revokes the exact Hub registration using only the stored bearer credential");
    using (var rejectedClient = new AgentUninstallClient(new UninstallHandler(HttpStatusCode.ServiceUnavailable)))
    {
        try { await rejectedClient.RevokeAsync(uninstallCredential); throw new InvalidOperationException("FAILED: rejected Hub revocation was accepted"); }
        catch (AgentUninstallException exception) when (exception.Reason == "hub-rejected" && exception.StatusCode == 503) { }
    }

    var uninstallDatabase = Path.Combine(directory, "uninstall.db");
    using (var uninstallStore = new ObservationStore(uninstallDatabase))
    {
        var observedAt = DateTimeOffset.UtcNow;
        var observation = new NetworkObservation(observedAt, 101, "TCP", "192.0.2.10", 49152, "198.51.100.20", 443,
            12, 1, ObservationLayer.Logical, null, "etw", "test-app");
        uninstallStore.DeliveryEnabled = true;
        uninstallStore.WriteBatch([observation]);
        uninstallStore.QueueForDelivery([observation], observedAt);
        var kept = uninstallStore.CompleteUninstallPreparation(false, true, false, observedAt);
        Assert(!uninstallStore.DeliveryEnabled && kept.PendingQueueDeleted == 1 && uninstallStore.ReadHistoryForExport(null, 10, 0).Count == 1,
            "successful preparation atomically disables delivery and clears its queue while keeping local history by default");
        uninstallStore.WriteBatch([observation with { ObservedAt = observedAt.AddSeconds(1) }]);
        var removed = uninstallStore.CompleteUninstallPreparation(true, false, true, observedAt.AddSeconds(2));
        Assert(removed.ContinuedWithoutRevocation && removed.LocalHistoryDeleted && uninstallStore.ReadHistoryForExport(null, 10, 0).Count == 0,
            "the explicit local-history choice deletes history while manual Hub revocation remains visible in the result");
    }

    var notificationNow = new DateTimeOffset(2026, 9, 8, 6, 0, 0, TimeSpan.Zero);
    Assert(NotificationPolicy.Evaluate(true, true, false, 5, 5, null, notificationNow) == NotificationDecision.DailyLimit,
        "ordinary notifications respect the configured daily limit");
    Assert(NotificationPolicy.Evaluate(true, true, true, 5, 5, null, notificationNow) == NotificationDecision.Deliver,
        "monitoring notifications are exempt from the daily limit");
    Assert(NotificationPolicy.Evaluate(true, true, true, 5, 5, notificationNow.AddMinutes(-30), notificationNow) == NotificationDecision.Cooldown,
        "monitoring notifications still respect the one-hour per-event cooldown");
    Assert(NotificationPolicy.Evaluate(true, false, false, 0, 999, null, notificationNow) == NotificationDecision.CategoryDisabled,
        "a disabled category remains suppressed even when the daily limit is unlimited");

    var deliveryNotice = new DeliveryNotificationTracker();
    var deliveryAck = notificationNow.AddMinutes(-10);
    var shortFailure = new DeliveryNotificationSample(notificationNow, true, "retryable", 12, notificationNow, deliveryAck);
    Assert(deliveryNotice.Evaluate(shortFailure) == DeliveryNotificationAction.None &&
        deliveryNotice.Evaluate(shortFailure with { ObservedAt = notificationNow.AddMinutes(4) }) == DeliveryNotificationAction.None,
        "a short transient Hub failure does not notify");
    var longFailure = shortFailure with { ObservedAt = notificationNow.AddMinutes(5) };
    Assert(deliveryNotice.Evaluate(longFailure) == DeliveryNotificationAction.Outage,
        "a Hub failure with a five-minute-old pending queue becomes actionable");
    deliveryNotice.RecordAttempt(DeliveryNotificationAction.Outage, longFailure, false);
    Assert(deliveryNotice.Evaluate(longFailure with { ObservedAt = notificationNow.AddMinutes(30) }) == DeliveryNotificationAction.None &&
        deliveryNotice.Evaluate(longFailure with { ObservedAt = notificationNow.AddMinutes(65) }) == DeliveryNotificationAction.Outage,
        "a suppressed outage is retried after the bounded notification interval");
    var deliveredFailure = longFailure with { ObservedAt = notificationNow.AddMinutes(65) };
    deliveryNotice.RecordAttempt(DeliveryNotificationAction.Outage, deliveredFailure, true);
    Assert(deliveryNotice.Evaluate(deliveredFailure with { ObservedAt = notificationNow.AddMinutes(66), State = "up-to-date", Pending = 0 }) == DeliveryNotificationAction.None &&
        deliveryNotice.Evaluate(deliveredFailure with { ObservedAt = notificationNow.AddMinutes(66), State = "sending", Pending = 0,
            LastAcknowledgedAt = deliveryAck.AddMinutes(1) }) == DeliveryNotificationAction.None,
        "an empty queue or sending state without a confirmed completed ACK is not called a recovery");
    var acknowledgedRecovery = deliveredFailure with { ObservedAt = notificationNow.AddMinutes(66), State = "up-to-date", Pending = 0,
        LastAcknowledgedAt = deliveryAck.AddMinutes(1) };
    Assert(deliveryNotice.Evaluate(acknowledgedRecovery) == DeliveryNotificationAction.Recovery,
        "recovery requires a real ACK advance after a delivered outage notification");
    deliveryNotice.RecordAttempt(DeliveryNotificationAction.Recovery, acknowledgedRecovery, true);
    Assert(deliveryNotice.Evaluate(acknowledgedRecovery with { ObservedAt = notificationNow.AddMinutes(67) }) == DeliveryNotificationAction.None,
        "a delivered recovery closes the notified outage exactly once");

    var authNotice = new DeliveryNotificationTracker();
    Assert(authNotice.Evaluate(new(notificationNow, true, "authorization-required", 1, notificationNow, null)) == DeliveryNotificationAction.Outage,
        "an authorization rejection is actionable immediately");
    var rateNotice = new DeliveryNotificationTracker();
    var rateLimited = new DeliveryNotificationSample(notificationNow, true, "rate-limited", 2, notificationNow, null);
    Assert(rateNotice.Evaluate(rateLimited) == DeliveryNotificationAction.None &&
        rateNotice.Evaluate(rateLimited with { ObservedAt = notificationNow.AddMinutes(5) }) == DeliveryNotificationAction.Outage,
        "a 429 is tolerated briefly and reported only when the queue remains stale");
    var unnotified = new DeliveryNotificationTracker();
    var unnotifiedFailure = new DeliveryNotificationSample(notificationNow, true, "retryable", 1, notificationNow.AddMinutes(-6), deliveryAck);
    Assert(unnotified.Evaluate(unnotifiedFailure) == DeliveryNotificationAction.Outage, "a long outage is eligible for delivery");
    unnotified.RecordAttempt(DeliveryNotificationAction.Outage, unnotifiedFailure, false);
    Assert(unnotified.Evaluate(unnotifiedFailure with { ObservedAt = notificationNow.AddMinutes(1), State = "acknowledged", Pending = 0,
        LastAcknowledgedAt = deliveryAck.AddMinutes(1) }) == DeliveryNotificationAction.None,
        "recovery is never announced for an outage the user was not told about");

    var aiFrom = new DateTimeOffset(2026, 9, 8, 0, 0, 0, TimeSpan.Zero);
    PeriodAnalysis AiAnalysis(long connections, string prefix) => new(aiFrom, aiFrom.AddHours(6), connections, 12, 20,
        connections * 100, 3, 1, aiFrom, 100,
        Enumerable.Range(0, 15).Select(index => new AppDestinationAggregate(
            $"{prefix}-app-{index}", $"203.0.113.{index}", $"{prefix}-destination-{index}.example", index + 1, (index + 1) * 100, 0)).ToArray(), []);
    var aiContext = AiInsightContextBuilder.Build(AiAnalysis(120, "current"), AiAnalysis(90, "previous"), aiFrom.AddHours(7));
    var aiPreview = AiInsightContextBuilder.Preview(aiContext);
    Assert(aiContext.SchemaVersion == 1 && aiContext.TopApplications.Count == 10 && aiContext.TopDestinations.Count == 10,
        "AI context uses the versioned bounded facts contract and limits ranked names");
    Assert(!aiPreview.Contains("203.0.113", StringComparison.Ordinal) && !aiPreview.Contains("credential", StringComparison.OrdinalIgnoreCase),
        "AI context excludes raw addresses and credentials");
    Assert(AgentAiClient.ValidateOllamaEndpoint("http://127.0.0.1:11434").IsLoopback,
        "Ollama accepts a loopback HTTP endpoint");
    try { AgentAiClient.ValidateOllamaEndpoint("https://example.com"); throw new InvalidOperationException("FAILED: Ollama accepted a remote endpoint"); }
    catch (AiRequestException rejected) { Assert(rejected.Kind == AiFailureKind.RequestRejected, "a remote Ollama endpoint is refused as a rejected request"); }

    // A failure the reader sees must be a kind, not a sentence: the screen has
    // to say it in their language, and a message can carry an endpoint, a model
    // name or a path that does not belong on a status line.
    Assert(AiRequestException.Classify(new TaskCanceledException()) == AiFailureKind.Timeout,
        "a request that ran out of time is a timeout");
    Assert(AiRequestException.Classify(new AiRequestException(AiFailureKind.HttpStatus, "refused", 429)) == AiFailureKind.HttpStatus,
        "a refusal keeps its kind");
    Assert(new AiRequestException(AiFailureKind.HttpStatus, "refused", 429).StatusCode == 429,
        "the status code survives, because 401 and 429 need different actions");
    Assert(AiRequestException.Classify(new InvalidOperationException("something else")) == AiFailureKind.Unreadable,
        "an unrecognised failure is reported as unreadable rather than guessed at");
    var aiHistoryPath = Path.Combine(directory, "ai-history.jsonl");
    var aiStore = new AiConversationStore(aiHistoryPath); var aiConversation = Guid.NewGuid();
    aiStore.Append(new AiConversationMessage(Guid.NewGuid(), aiConversation, "user", "what changed", aiFrom, "Ollama", "local"));
    aiStore.Append(new AiConversationMessage(Guid.NewGuid(), aiConversation, "assistant", "bounded answer", aiFrom.AddSeconds(1), "Ollama", "local"));
    Assert(aiStore.Read().Count == 2, "AI conversation history persists locally");
    aiStore.Delete(aiConversation);
    Assert(aiStore.Read().Count == 0, "an AI conversation can be deleted without touching observations");
    var aiHandler = new AiHandler("""{"output":[{"content":[{"type":"output_text","text":"Bounded result"}]}],"usage":{"input_tokens":100,"output_tokens":20}}""");
    using (var aiClient = new AgentAiClient(aiHandler))
    {
        var localOnly = new AiConversationMessage(Guid.NewGuid(), aiConversation, "assistant", "LOCAL-ONLY", aiFrom, "Ollama", "local");
        var preview = aiClient.BuildPreview(AiProviderKind.OpenAI, "gpt-5.6-luna", aiContext, [localOnly], "what changed?");
        Assert(preview.Contains("developerInstruction", StringComparison.Ordinal) && preview.Contains("what changed?", StringComparison.Ordinal) &&
            !preview.Contains("api-key", StringComparison.OrdinalIgnoreCase) && !preview.Contains("LOCAL-ONLY", StringComparison.Ordinal),
            "the exact AI preview contains every transmitted context component, no credential, and no other-provider history");
        var reply = await aiClient.ChatAsync(AiProviderKind.OpenAI, "gpt-5.6-luna", "secret-key", "http://127.0.0.1:11434",
            aiContext, [], "what changed?", CancellationToken.None);
        Assert(reply.Text == "Bounded result" && reply.EstimatedCostUsd == 0.000044m && aiHandler.SawBearer && !aiHandler.Body.Contains("secret-key", StringComparison.Ordinal),
            "OpenAI request authenticates by header, parses bounded output, estimates cost, and never puts the key in JSON");
    }

    var dnsNames = new DnsNameCache(TimeSpan.FromMinutes(10), capacity: 4);
    var dnsAt = DateTimeOffset.UtcNow;
    dnsNames.Observe(42, "API.Bücher.Example.", "203.0.113.8;::ffff:203.0.113.9;", dnsAt);
    Assert(dnsNames.Resolve(42, "203.0.113.8", dnsAt.AddSeconds(1)) == "api.xn--bcher-kva.example" &&
        dnsNames.Resolve(42, "203.0.113.9", dnsAt.AddSeconds(1)) == "api.xn--bcher-kva.example",
        "DNS metadata is normalized with IDNA and IPv4-mapped addresses before bounded PID/IP correlation");
    Assert(dnsNames.Resolve(43, "203.0.113.8", dnsAt.AddSeconds(1)) is null &&
        dnsNames.Resolve(42, "203.0.113.8", dnsAt.AddMinutes(11)) is null,
        "hostname correlation does not cross process identity or its bounded lifetime");

    Assert(EgressView.Agent.Service.Program.CommandLineFailureMessage(new UnauthorizedAccessException()) ==
        "EgressView Agent command failed: IPC access denied.",
        "CLI access denial is converted to a controlled error instead of an unhandled Windows error");

    using (var store = new ObservationStore(database))
    {
        await using var pipeline = new ObservationPipeline(store, capacity: 32, batchSize: 8);
        for (var index = 0; index < 20; index++)
        {
            Assert(pipeline.TrySubmit(new NetworkObservation(
                DateTimeOffset.UtcNow, 42, "UDP", "100.64.0.1", 50_000 + index,
                "100.64.0.2", 443, 512, null, ObservationLayer.Logical, "63", "etw", "TestApp", "api.example.com")), "observation accepted");
        }
    }

    using (var reopened = new ObservationStore(database))
    {
        var inspection = reopened.Inspect();
        Assert(inspection.Count == 20, "restart preserves all observations");
        Assert(inspection.Integrity == "ok", "integrity check is ok");
        Assert(reopened.ReadProcessNameStats() == (20, 0), "process names survive restart");
        var recent = reopened.ReadRecentFlows(50);
        Assert(recent.Count == 20 && recent.All(flow => flow.ProcessName == "TestApp" && flow.RemoteHostname == "api.example.com"),
            "bounded recent flows expose persisted process identity and hostname to the local UI");
        Assert(reopened.ReadRecentFlows(50, 10).Count == 10,
            "recent flow pagination supports complete bounded CSV export");

        var report = DiagnosticsReport.Create(
            new CollectorSnapshot("healthy", 20, 20, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 32),
            reopened, "test");
        using var json = JsonDocument.Parse(report);
        Assert(json.RootElement.GetProperty("database").GetProperty("observationCount").GetInt64() == 20, "diagnostics count");
        Assert(json.RootElement.GetProperty("database").GetProperty("storageBytes").GetInt64() > 0,
            "diagnostics reports privacy-safe database disk usage");
        Assert(json.RootElement.GetProperty("delivery").GetProperty("pending").GetInt64() == 0, "diagnostics reports privacy-safe delivery state");
        Assert(!report.Contains("100.64.0.1", StringComparison.Ordinal), "diagnostics excludes endpoint");
        Assert(!report.Contains("UDP", StringComparison.Ordinal), "diagnostics excludes raw observation");
        Assert(!report.Contains("TestApp", StringComparison.Ordinal), "diagnostics excludes process names");
        Assert(json.RootElement.GetProperty("health").GetProperty("status").GetString() == "healthy", "healthy state is explicit");
        var bundle = Path.Combine(directory, "diagnostics.zip");
        DiagnosticsBundle.Create(bundle, report);
        using var archive = System.IO.Compression.ZipFile.OpenRead(bundle);
        Assert(archive.Entries.Select(entry => entry.FullName).ToHashSet(StringComparer.Ordinal)
                .SetEquals(new[] { "README.txt", "diagnostics.json", "diagnostics.txt" }),
            "diagnostics bundle contains only documented privacy-safe files");
        using var bundleReader = new StreamReader(archive.GetEntry("diagnostics.json")!.Open());
        Assert(!bundleReader.ReadToEnd().Contains("100.64.0.1", StringComparison.Ordinal), "bundle excludes endpoint");
        using var textReader = new StreamReader(archive.GetEntry("diagnostics.txt")!.Open());
        Assert(textReader.ReadToEnd().Contains("Database integrity: ok", StringComparison.Ordinal),
            "diagnostics bundle includes a human-readable summary alongside JSON");
        var unsafeReport = DiagnosticsReport.Create(
            new CollectorSnapshot("degraded", 0, 0, 0, 1, null, null, 32, CollectorError: "IOException: C:\\Users\\secret\\agent.db"),
            reopened, "test");
        Assert(unsafeReport.Contains("IOException", StringComparison.Ordinal) && !unsafeReport.Contains("secret", StringComparison.Ordinal),
            "free-text collector failures are reduced to a safe classification before export");

        var beforeBackup = reopened.ReadStorageBytes();
        File.WriteAllBytes(database + ".pre-v99.bak", new byte[123]);
        Assert(reopened.ReadStorageBytes() == beforeBackup + 123,
            "disk usage includes retained migration backups alongside SQLite files");
        File.WriteAllBytes(database + ".unrelated.bak", new byte[321]);
        Assert(reopened.ReadStorageBytes() == beforeBackup + 123,
            "disk usage excludes unrelated files in the data directory");
    }

    var stoppedHealth = AgentHealth.Evaluate(
        new CollectorSnapshot("degraded", 10, 0, 0, 1, DateTimeOffset.UtcNow, null, 32, PersistenceError: "disk-full"), "ok");
    Assert(stoppedHealth.Status == "stopped" && stoppedHealth.Issues.Single().Code == "disk-full",
        "disk-full health is stopped with actionable reason");

    var ipcStatus = IpcProtocol.Handle("""{"v":1,"op":"status"}""", () => """{"health":{"status":"healthy"}}""", _ => []);
    Assert(ipcStatus.Contains("\"status\":\"ok\"", StringComparison.Ordinal), "IPC v1 status is accepted");
    var ipcDiagnostics = IpcProtocol.Handle("""{"v":1,"op":"diagnostics"}""", () => "{}", _ => [],
        diagnostics: () => """{"privacy":{"includesEndpoints":false}}""");
    Assert(ipcDiagnostics.Contains("includesEndpoints", StringComparison.Ordinal),
        "authenticated IPC exposes a separately requested integrity-checked diagnostic report");
    var prepareResponse = IpcProtocol.Handle("""{"v":1,"op":"prepare-uninstall","removeHistory":true,"continueWithoutRevocation":false}""", () => "{}", _ => [],
        prepareUninstall: (removeHistory, manual) => new AgentUninstallResult(true, manual, removeHistory, 7));
    Assert(prepareResponse.Contains("\"HubRegistrationRevoked\":true", StringComparison.Ordinal) && prepareResponse.Contains("\"PendingQueueDeleted\":7", StringComparison.Ordinal),
        "authenticated IPC passes the explicit history choice and returns the completed uninstall boundary");
    var failedPrepare = IpcProtocol.Handle("""{"v":1,"op":"prepare-uninstall"}""", () => "{}", _ => [],
        prepareUninstall: (_, _) => throw new AgentUninstallException("network-error"));
    Assert(failedPrepare.Contains("network-error", StringComparison.Ordinal),
        "Hub revocation failure is classified for retry instead of being mistaken for completed cleanup");
    bool? monitoringEnabled = null;
    var monitoringResponse = IpcProtocol.Handle("""{"v":1,"op":"set-monitoring-enabled","enabled":false}""", () => "{}", _ => [],
        setMonitoringEnabled: enabled => { monitoringEnabled = enabled; return enabled; });
    Assert(monitoringEnabled == false && monitoringResponse.Contains("\"enabled\":false", StringComparison.Ordinal),
        "authenticated IPC changes the monitoring state without stopping the service");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"set-monitoring-enabled","enabled":"no"}""", () => "{}", _ => [],
        setMonitoringEnabled: enabled => enabled).Contains("invalid-monitoring-setting", StringComparison.Ordinal),
        "IPC rejects a non-boolean monitoring state");

    // RecordUiRun existed and compiled for weeks with nothing calling it,
    // because the protocol had no case for the op the window was sending. The
    // window swallows the rejection, so the only evidence was run_history
    // holding zero rows for the UI on a machine that had run it all day.
    var uiStages = new List<(string Stage, string? Fault)>();
    var uiBegin = IpcProtocol.Handle("""{"v":1,"op":"ui-run","stage":"begin"}""", () => "{}", _ => [],
        recordUiRun: (stage, fault) => uiStages.Add((stage, fault)));
    IpcProtocol.Handle("""{"v":1,"op":"ui-run","stage":"fault","fault":"System.InvalidOperationException"}""", () => "{}", _ => [],
        recordUiRun: (stage, fault) => uiStages.Add((stage, fault)));
    Assert(uiStages.SequenceEqual([("begin", (string?)null), ("fault", "System.InvalidOperationException")]) &&
        uiBegin.Contains("\"status\":\"ok\"", StringComparison.Ordinal),
        "the window's run reports reach the service that holds its run id");
    // An unrecognised stage must be refused, not dropped: a begin that never
    // registers leaves the run open, and the next start files it as a crash.
    Assert(IpcProtocol.Handle("""{"v":1,"op":"ui-run","stage":"start"}""", () => "{}", _ => [],
        recordUiRun: (_, _) => { }).Contains("invalid-run-stage", StringComparison.Ordinal),
        "an unknown run stage is rejected rather than silently ignored");
    var deliveryStatusResponse = IpcProtocol.Handle("""{"v":1,"op":"delivery-status"}""", () => "{}", _ => [],
        deliveryStatus: () => """{"enrolled":true,"pending":4,"state":"rate-limited"}""");
    Assert(deliveryStatusResponse.Contains("\"pending\":4", StringComparison.Ordinal) && deliveryStatusResponse.Contains("rate-limited", StringComparison.Ordinal),
        "authenticated IPC exposes classified delivery status without credentials");
    var sendRequested = false;
    Assert(IpcProtocol.Handle("""{"v":1,"op":"send-delivery-now"}""", () => "{}", _ => [],
        requestDeliveryNow: () => sendRequested = true).Contains("\"status\":\"ok\"", StringComparison.Ordinal) && sendRequested,
        "authenticated IPC schedules a manual delivery attempt");
    var presentedStatus = IpcResponsePresenter.Present("""{"status":"ok","data":{"health":{"status":"healthy","issues":[]},"database":{"observationCount":1234,"integrity":"ok"},"collector":{"LastPersistedAt":"2026-08-30T00:00:00Z"}}}""");
    Assert(presentedStatus.Contains("healthy", StringComparison.Ordinal) && presentedStatus.Contains("1,234", StringComparison.Ordinal), "IPC status is presented for people");
    var presentedSummary = IpcResponsePresenter.Present("""{"status":"ok","days":7,"data":[{"ObservationCount":2,"BytesSent":1024,"BytesReceived":2048,"BytesUnknown":1}]}""");
    Assert(presentedSummary.Contains("1.0 KiB", StringComparison.Ordinal) && presentedSummary.Contains("2.0 KiB", StringComparison.Ordinal), "IPC summary formats totals and byte units");
    var ipcSummary = IpcProtocol.Handle("""{"v":1,"op":"summary","days":7}""", () => "{}", days =>
        [new HourlySummary(DateTimeOffset.UtcNow, "TCP", ObservationLayer.Logical, days, 1, 2, 0)]);
    Assert(ipcSummary.Contains("\"days\":7", StringComparison.Ordinal), "IPC permits only fixed 7-day summary");
    var recentResponse = IpcProtocol.Handle("""{"v":1,"op":"recent-flows","limit":100}""", () => "{}", _ => [],
        recentFlows: (limit, offset) => [new RecentFlow(DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, "TCP", "10.0.0.1", 50000,
            "203.0.113.8", 443, 42, "Browser", 10, 20, ObservationLayer.Logical, "if", "etw")]);
    Assert(recentResponse.Contains("203.0.113.8", StringComparison.Ordinal), "IPC returns bounded recent flow data to the authenticated UI");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"recent-flows","limit":101}""", () => "{}", _ => [], recentFlows: (_, _) => []).Contains("invalid-limit", StringComparison.Ordinal),
        "IPC rejects arbitrary recent flow limits");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"recent-flows","limit":500,"offset":-1}""", () => "{}", _ => [], recentFlows: (_, _) => []).Contains("invalid-offset", StringComparison.Ordinal),
        "IPC rejects invalid pagination offsets");
    var historyNow = new DateTimeOffset(2026, 9, 10, 0, 0, 0, TimeSpan.Zero);
    var historyStatusResponse = IpcProtocol.Handle("""{"v":1,"op":"history-status"}""", () => "{}", _ => [],
        historyStatus: () => new LocalHistoryStatus(30, 14, 4096, historyNow.AddDays(-2), historyNow.AddDays(-20), historyNow.AddHours(-1), historyNow.AddHours(23)));
    Assert(historyStatusResponse.Contains("\"RetentionDays\":30", StringComparison.Ordinal) && historyStatusResponse.Contains("\"StorageBytes\":4096", StringComparison.Ordinal),
        "IPC exposes retention policy, actual disk use, stored ranges, and next cleanup");
    var setRetentionResponse = IpcProtocol.Handle("""{"v":1,"op":"set-history-retention","days":7}""", () => "{}", _ => [],
        setHistoryRetention: days => new LocalHistoryStatus(days, days, 1, null, null, null, historyNow));
    Assert(setRetentionResponse.Contains("\"RetentionDays\":7", StringComparison.Ordinal) &&
        IpcProtocol.Handle("""{"v":1,"op":"set-history-retention","days":8}""", () => "{}", _ => [], setHistoryRetention: _ => throw new Exception()).Contains("invalid-retention", StringComparison.Ordinal),
        "IPC accepts only the documented retention choices");
    var exportResponse = IpcProtocol.Handle("""{"v":1,"op":"history-export","before":"2026-09-10T00:00:00Z","limit":500,"offset":0}""", () => "{}", _ => [],
        historyExport: (_, _, _) => [new RecentFlow(historyNow.AddDays(-2), historyNow.AddDays(-1), "TCP", "10.0.0.1", 1, "203.0.113.1", 443, 1, "Exported", 1, 2, ObservationLayer.Logical, null, "etw")]);
    Assert(exportResponse.Contains("Exported", StringComparison.Ordinal), "IPC pages only authenticated local-history export rows");
    var deleteInvoked = false;
    var deleteResponse = IpcProtocol.Handle("""{"v":1,"op":"delete-history","scope":"before","before":"2026-09-01T00:00:00Z"}""", () => "{}", _ => [],
        deleteHistory: _ => { deleteInvoked = true; return new LocalHistoryDeletionResult(1, 1, 1, 1, 1); });
    Assert(deleteInvoked && deleteResponse.Contains("\"TotalDeleted\":5", StringComparison.Ordinal),
        "IPC requires an explicit deletion scope and returns an auditable row count");
    var globeResponse = IpcProtocol.Handle("""{"v":1,"op":"globe","days":7}""", () => "{}", _ => [],
        globePoints: _ => [new GlobePoint(35.68, 139.76, "JP", "Tokyo", 4, 1024)]);
    Assert(globeResponse.Contains("Tokyo", StringComparison.Ordinal), "IPC returns bounded globe aggregates to the authenticated UI");
    var countryHistoryResponse = IpcProtocol.Handle("""{"v":1,"op":"country-history","scope":"all"}""", () => "{}", _ => [],
        countryHistory: minutes =>
        {
            Assert(minutes is null, "all-time country history is not silently reduced to a display period");
            return [new CountryHistoryRow("JP", 4, DateTimeOffset.UnixEpoch, DateTimeOffset.UtcNow)];
        });
    Assert(countryHistoryResponse.Contains("\"CountryCode\":\"JP\"", StringComparison.Ordinal),
        "IPC returns country history without unknown locations");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"country-history","scope":"week"}""", () => "{}", _ => [],
        countryHistory: _ => []).Contains("invalid-country-history-scope", StringComparison.Ordinal),
        "IPC rejects ambiguous country-history scopes");
    var analysisResponse = IpcProtocol.Handle("""{"v":1,"op":"analysis","minutes":360}""", () => "{}", _ => [],
        analysis: (minutes, offset) => new PeriodAnalysis(DateTimeOffset.UtcNow.AddMinutes(-minutes-offset), DateTimeOffset.UtcNow.AddMinutes(-offset),
            12, 2, 3, 4096, 1, 1, DateTimeOffset.UtcNow.AddDays(-1), 20, [], []));
    Assert(analysisResponse.Contains("\"Connections\":12", StringComparison.Ordinal), "IPC returns bounded period analysis");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"analysis","minutes":61}""", () => "{}", _ => [], analysis: (_, _) => throw new InvalidOperationException()).Contains("invalid-range", StringComparison.Ordinal),
        "IPC rejects an arbitrary analysis range");
    var csv = ObservationCsv.Export([new RecentFlow(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, "TCP", "::1", 50000,
        "203.0.113.8", 443, 42, "Browser, \"Beta\"", null, 20, ObservationLayer.Logical, null, "etw", null, "JP")]);
    Assert(csv.Contains("\"Browser, \"\"Beta\"\"\"", StringComparison.Ordinal) && csv.Contains("remote_hostname", StringComparison.Ordinal) &&
        csv.Contains("country_code", StringComparison.Ordinal) && csv.Contains(",JP,", StringComparison.Ordinal) && csv.EndsWith("\r\n", StringComparison.Ordinal),
        "CSV includes hostname and country, follows RFC 4180 quoting and ends with a record separator");
    Assert(IpcProtocol.Handle("""{"v":99,"op":"status"}""", () => "{}", _ => []).Contains("version-mismatch", StringComparison.Ordinal),
        "IPC rejects unknown protocol version");
    var rejectedOperation = IpcProtocol.Handle("""{"v":1,"op":"read_file","path":"C:\\\\Windows\\\\win.ini"}""", () => "{}", _ => []);
    Assert(rejectedOperation.Contains("unknown-operation", StringComparison.Ordinal) && !rejectedOperation.Contains("win.ini", StringComparison.Ordinal),
        "IPC rejects and does not echo arbitrary path operations");

    using (var dropStore = new ObservationStore(Path.Combine(directory, "drops.db")))
    {
        await using var constrained = new ObservationPipeline(dropStore, capacity: 1, batchSize: 1);
        for (var index = 0; index < 10_000; index++)
        {
            constrained.TrySubmit(new NetworkObservation(
                DateTimeOffset.UtcNow, 7, "UDP", "127.0.0.1", index, "127.0.0.1", 9,
                1, 0, ObservationLayer.Logical, null, "etw"));
        }
        Assert(constrained.Snapshot().QueueFullDrops > 0, "bounded queue reports drops");
    }

    using (var reopenedDrops = new ObservationStore(Path.Combine(directory, "drops.db")))
    {
        Assert(reopenedDrops.ReadCounters().GetValueOrDefault("queue-full") > 0, "drop reason survives restart");
    }

    var coverageDatabase = Path.Combine(directory, "coverage.db");
    using (var coverageStore = new ObservationStore(coverageDatabase))
    {
        var started = DateTimeOffset.UtcNow;
        var snapshot = new[]
        {
            new StartupFlow("TCP", "10.0.0.1", 50000, "10.0.0.2", 443, 99, "SnapshotApp"),
            new StartupFlow("TCP", "10.0.0.1", 50001, "10.0.0.3", 443, 99, "SnapshotApp"),
        };
        var firstCoverage = coverageStore.BeginCoverage(snapshot, started);
        await using (var flowPipeline = new ObservationPipeline(coverageStore))
        {
            Assert(flowPipeline.TrySubmit(new NetworkObservation(started.AddSeconds(1), 99, "TCP",
                "10.0.0.1", 50000, "10.0.0.2", 443, 128, 0,
                ObservationLayer.Logical, "test", "etw", "EtwApp")), "ETW flow accepted");
        }
        var flowStats = coverageStore.ReadFlowStats();
        Assert(flowStats.Total == 2 && flowStats.Both == 1 && flowStats.Snapshot == 1, "snapshot and ETW upsert to one flow");
        Assert(flowStats.BytesUnknown == 1, "snapshot-only bytes remain unknown");
        Assert(coverageStore.ReadProcessNameStats() == (2, 0), "snapshot and ETW process names are retained");
        coverageStore.EndCoverage(firstCoverage, started.AddSeconds(2));
        Assert(coverageStore.ReadCoverage() == (1, 0, 0), "normal coverage closes");
        var abandoned = coverageStore.BeginCoverage(snapshot, started.AddSeconds(3));
        coverageStore.ConfirmCoverage(abandoned, started.AddSeconds(5));
        var activeAfterRestart = coverageStore.BeginCoverage(snapshot, started.AddSeconds(10));
        Assert(coverageStore.ReadCoverage() == (3, 1, 1), "previous open coverage is abandoned");
        var crashWindow = coverageStore.ReadPeriodAnalysis(started.AddSeconds(3), started.AddSeconds(10));
        Assert(Math.Abs(crashWindow.CoverageRatio - (2d / 7d)) < 0.001,
            "abrupt termination stops coverage at the last heartbeat instead of extending to restart");

        coverageStore.InterruptCoverage(activeAfterRestart, started.AddSeconds(12));
        coverageStore.BeginSleepPeriod(started.AddSeconds(12));
        coverageStore.EndSleepPeriod(started.AddSeconds(20));
        var resumed = coverageStore.BeginCoverage(snapshot, started.AddSeconds(20));
        coverageStore.EndCoverage(resumed, started.AddSeconds(22));
        var suspendWindow = coverageStore.ReadPeriodAnalysis(started.AddSeconds(10), started.AddSeconds(22));
        Assert(Math.Abs(suspendWindow.CoverageRatio - (4d / 12d)) < 0.001,
            "a heartbeat or ETW-loss interruption leaves the unconfirmed gap outside monitoring coverage");
        Assert(suspendWindow.SleepPeriods.Count == 1 && suspendWindow.SleepPeriods[0] ==
            new SleepPeriod(started.AddSeconds(12), started.AddSeconds(20)) && suspendWindow.SleepSeconds == 8,
            "an SCM-confirmed sleep is disclosed over the same interval excluded from monitoring coverage");
        var clippedSleep = coverageStore.ReadSleepPeriods(started.AddSeconds(14), started.AddSeconds(18));
        Assert(clippedSleep.SequenceEqual([new SleepPeriod(started.AddSeconds(14), started.AddSeconds(18))]),
            "sleep disclosure is clipped to the selected chart period");
    }

    var liveSnapshot = StartupSnapshot.Capture();
    Assert(liveSnapshot.Where(flow => flow.Protocol == "TCP").All(flow => flow.RemotePort > 0),
        "TCP startup snapshot excludes listeners");

    var legacyDatabase = Path.Combine(directory, "legacy-v1.db");
    ObservationStore.CreateVersion1FixtureForTesting(legacyDatabase);
    using (var migrated = new ObservationStore(legacyDatabase))
    {
        Assert(migrated.SchemaVersion == 17, "v1 database migrates through v2-v17");
        Assert(!migrated.DeliveryEnabled, "delivery is opt-in after migration");
        Assert(migrated.Inspect().Integrity == "ok", "migrated database integrity is ok");
    }
    var migrationBackups = Directory.GetFiles(directory, "legacy-v1.db.pre-v*.bak");
    Assert(migrationBackups.Length == 1 && migrationBackups.Single().EndsWith("pre-v17.bak", StringComparison.Ordinal),
        "migration retains only the newest consistent backup generation");
    using (var migratedAgain = new ObservationStore(legacyDatabase))
        Assert(migratedAgain.SchemaVersion == 17, "migration is idempotent on restart");

    var retentionDatabase = Path.Combine(directory, "retention.db");
    using (var retentionStore = new ObservationStore(retentionDatabase))
    {
        var now = new DateTimeOffset(2026, 9, 6, 12, 0, 0, TimeSpan.Zero);
        retentionStore.WriteBatch([
            new NetworkObservation(now.AddDays(-15), 1, "TCP", "10.0.0.1", 40001, "203.0.113.1", 443, 1, 1, ObservationLayer.Logical, null, "etw", "OldRaw"),
            new NetworkObservation(now.AddDays(-13), 2, "TCP", "10.0.0.1", 40002, "203.0.113.2", 443, 1, 1, ObservationLayer.Logical, null, "etw", "FreshRaw"),
            new NetworkObservation(now.AddDays(-31), 3, "TCP", "10.0.0.1", 40003, "203.0.113.3", 443, 1, 1, ObservationLayer.Logical, null, "etw", "OldAggregate")
        ]);
        retentionStore.FoldCompletedHoursForCharts(now);
        var oldCoverage = retentionStore.BeginCoverage([], now.AddDays(-31));
        retentionStore.EndCoverage(oldCoverage, now.AddDays(-31).AddMinutes(1));
        retentionStore.BeginSleepPeriod(now.AddDays(-31));
        retentionStore.EndSleepPeriod(now.AddDays(-31).AddMinutes(1));
        var result = retentionStore.PruneRetentionBatch(now, batchSize: 1);
        Assert(result.ObservationsDeleted == 1 && result.FlowsDeleted == 1 && result.HourlySummariesDeleted == 1 && result.CoverageSessionsDeleted == 1 && result.ChartSummariesDeleted == 1 && result.SleepPeriodsDeleted == 1,
            "retention prunes raw data at 14 days and aggregates at 30 days in bounded batches");
        var second = retentionStore.PruneRetentionBatch(now, batchSize: 10);
        Assert(second.ObservationsDeleted == 1 && second.FlowsDeleted == 1,
            "individual observations and flow-log records use the same 14-day raw boundary");
        Assert(retentionStore.Inspect().Count == 1 && retentionStore.ReadRecentFlows(50).Count == 1,
            "fresh raw data and 30-day aggregate data survive retention");
        retentionStore.WriteBatch([
            new NetworkObservation(now.AddDays(-31), 4, "TCP", "10.0.0.1", 40004, "203.0.113.4", 443, 1, 1, ObservationLayer.Logical, null, "etw", "Queued")
        ], queueForDelivery: true);
        var pending = retentionStore.ReadDeliveryStatus().Pending;
        while (retentionStore.PruneRetentionBatch(now, batchSize: 10).TotalDeleted > 0) { }
        Assert(pending == 1 && retentionStore.ReadDeliveryStatus().Pending == 1,
            "retention never deletes unsent delivery queue data");
    }

    using (var historyStore = new ObservationStore(Path.Combine(directory, "history-controls.db")))
    {
        var now = new DateTimeOffset(2026, 9, 10, 12, 0, 0, TimeSpan.Zero);
        historyStore.SetRetentionDays(7);
        historyStore.WriteBatch([
            new NetworkObservation(now.AddDays(-8), 1, "TCP", "10.0.0.1", 41001, "203.0.113.10", 443, 1, 2, ObservationLayer.Logical, null, "etw", "Expired"),
            new NetworkObservation(now.AddDays(-2), 2, "TCP", "10.0.0.1", 41002, "203.0.113.11", 443, 3, 4, ObservationLayer.Logical, null, "etw", "DeleteMe"),
            new NetworkObservation(now.AddHours(-2), 3, "TCP", "10.0.0.1", 41003, "203.0.113.12", 443, 5, 6, ObservationLayer.Logical, null, "etw", "KeepMe")
        ]);
        historyStore.WriteBatch([
            new NetworkObservation(now.AddDays(-3), 4, "TCP", "10.0.0.1", 41004, "203.0.113.13", 443, 7, 8, ObservationLayer.Logical, null, "etw", "Queued")
        ], queueForDelivery: true);
        while (historyStore.PruneRetentionBatch(now, 10).TotalDeleted > 0) { }
        historyStore.MarkRetentionMaintenanceCompleted(now);
        var historyStatus = historyStore.ReadLocalHistoryStatus(now);
        Assert(historyStatus.RetentionDays == 7 && historyStatus.RawDays == 7 && historyStatus.StorageBytes > 0 && historyStatus.LastCleanupAt == now,
            "user-selected retention is durable and history status reports actual storage and cleanup timing");
        var exportRows = historyStore.ReadHistoryForExport(now.AddDays(-1), 500, 0);
        Assert(exportRows.Count == 2 && exportRows.All(item => item.ProcessName is "DeleteMe" or "Queued"),
            "delete-before export returns exactly the individual flow records about to be removed");
        var pendingBeforeDelete = historyStore.ReadDeliveryStatus().Pending;
        var observationsBeforeInterruptedDelete = historyStore.Inspect().Count;
        var flowsBeforeInterruptedDelete = historyStore.ReadRecentFlows(50).Count;
        historyStore.FailHistoryDeletionForTesting(true);
        try { historyStore.DeleteLocalHistory(now.AddDays(-1), now); throw new InvalidOperationException("FAILED: interrupted history deletion unexpectedly committed"); }
        catch (ObservationStoreException) { }
        historyStore.FailHistoryDeletionForTesting(false);
        Assert(historyStore.Inspect().Count == observationsBeforeInterruptedDelete && historyStore.ReadRecentFlows(50).Count == flowsBeforeInterruptedDelete,
            "an interrupted or disk-full history deletion rolls back every local history table");
        var deleted = historyStore.DeleteLocalHistory(now.AddDays(-1), now);
        Assert(deleted.TotalDeleted > 0 && historyStore.ReadRecentFlows(50).Single().ProcessName == "KeepMe" &&
            historyStore.ReadDeliveryStatus().Pending == pendingBeforeDelete,
            "dated history deletion is atomic across local history tables and excludes the durable Hub queue");
        historyStore.DeleteLocalHistory(null, now);
        Assert(historyStore.Inspect().Count == 0 && historyStore.ReadRecentFlows(50).Count == 0 &&
            historyStore.ReadDeliveryStatus().Pending == pendingBeforeDelete,
            "delete-all removes local observation history without deleting unsent Hub delivery");
    }
    using (var reopenedHistory = new ObservationStore(Path.Combine(directory, "history-controls.db")))
        Assert(reopenedHistory.ReadLocalHistoryStatus(DateTimeOffset.UtcNow).RetentionDays == 7,
            "the selected retention survives a service restart");


    using (var timelineStore = new ObservationStore(Path.Combine(directory, "timeline-observed-at.db")))
    {
        var from = new DateTimeOffset(2026, 9, 6, 0, 0, 0, TimeSpan.Zero);
        timelineStore.WriteBatch([
            new NetworkObservation(from.AddMinutes(10), 42, "TCP", "10.0.0.1", 51000,
                "203.0.113.42", 443, 10, 20, ObservationLayer.Logical, null, "etw", "LongLived"),
            new NetworkObservation(from.AddHours(2).AddMinutes(10), 42, "TCP", "10.0.0.1", 51000,
                "203.0.113.42", 443, 30, 40, ObservationLayer.Logical, null, "etw", "LongLived")
        ]);
        Assert(timelineStore.FoldCompletedHoursForCharts(from.AddHours(3)) == 2 &&
            timelineStore.FoldCompletedHoursForCharts(from.AddHours(3)) == 0,
            "completed chart hours fold once and the watermark makes the operation idempotent");
        var timeline = timelineStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(timeline.Connections == 1 && timeline.Timeline.Sum(item => item.Connections) == 2 &&
            timeline.Timeline.Select(item => item.Bucket).ToHashSet().SetEquals([0, 2]),
            "timeline uses each observation time instead of moving one long-lived flow into its last-seen bucket");
        timelineStore.WriteBatch([
            new NetworkObservation(from.AddHours(3).AddMinutes(10), 43, "UDP", "10.0.0.1", 51001,
                "198.51.100.43", 443, null, null, ObservationLayer.Logical, null, "etw", "CurrentHour")
        ]);
        timeline = timelineStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(timeline.Timeline.Sum(item => item.Connections) == 3 && timeline.Timeline.Any(item => item.Bucket == 3),
            "timeline combines folded complete hours with the current raw hour without gaps or duplicates");
    }

    using (var geoStore = new ObservationStore(Path.Combine(directory, "geo.db")))
    {
        var observedAt = DateTimeOffset.UtcNow.AddMinutes(-1);
        geoStore.WriteBatch([
            new NetworkObservation(observedAt, 9, "TCP", "10.0.0.1", 50000,
                "203.0.113.8", 443, 10, 20, ObservationLayer.Logical, null, "etw", "Browser", "API.Bad.Example."),
            new NetworkObservation(observedAt, 10, "TCP", "10.0.0.1", 50001,
                "198.51.100.7", 443, 1, 2, ObservationLayer.Logical, null, "etw", "DirectIp")
        ]);
        geoStore.ReplaceGeoLocations([new GeoLocation("203.0.113.8", 35.68, 139.76, "JP", "Tokyo")], "etag-1", observedAt);
        var globe = geoStore.ReadGlobePoints(observedAt.AddMinutes(-1), DateTimeOffset.UtcNow);
        Assert(globe.Count == 1 && globe[0].City == "Tokyo" && globe[0].Connections == 1 && globe[0].Bytes == 30,
            "geo cache joins locally with observations without exposing the full cache to UI");
        var countryHistory = geoStore.ReadCountryHistory();
        Assert(countryHistory.Count == 1 && countryHistory[0].CountryCode == "JP" && countryHistory[0].Connections == 1 &&
            countryHistory[0].FirstObservedAt == observedAt && countryHistory[0].LastObservedAt == observedAt &&
            countryHistory[0].RecentApplication == "Browser",
            "all-time country history includes the latest app and dates without counting an unplaced address");
        Assert(geoStore.ReadGeoCacheState() is { ETag: "etag-1", LocationCount: 1 }, "geo cache state reports its version and exact location count");
        Assert(geoStore.ReadRecentFlows(50).Single(flow => flow.RemoteAddress == "203.0.113.8").CountryCode == "JP" &&
            geoStore.ReadRecentFlows(50).Single(flow => flow.RemoteAddress == "198.51.100.7").CountryCode is null,
            "connection log rows include enriched country while preserving explicit unknown country");
        var coverage = geoStore.BeginCoverage([], observedAt.AddMinutes(-1));
        var analysis = geoStore.ReadPeriodAnalysis(observedAt.AddMinutes(-2), DateTimeOffset.UtcNow);
        Assert(analysis.Connections == 2 && analysis.Applications == 2 && analysis.Destinations == 2 && analysis.Bytes == 33,
            "period analysis returns exact whole-period totals instead of a recent-row sample");
        Assert(analysis.StorageBytes > 0, "period analysis exposes actual local database storage instead of traffic bytes");
        Assert(analysis.Links.Single(link => link.Application == "Browser").DestinationName == "api.bad.example" && analysis.Timeline.Sum(item => item.Connections) == 2,
            "period analysis uses the observed hostname as Name and falls back explicitly to IP");
        geoStore.EndCoverage(coverage, DateTimeOffset.UtcNow);

        geoStore.ReplaceThreatIndicators(true,
            [new ThreatIndicator("domain", "bad.example", "test-feed", "test domain", "high")], "threat-etag", observedAt);
        var threatReport = geoStore.ReadThreatReport(observedAt.AddMinutes(-2), DateTimeOffset.UtcNow);
        Assert(threatReport.Availability == "available" && threatReport.CheckedDestinations == 2 &&
            threatReport.DomainCheckedDestinations == 1 && threatReport.DomainUncheckedDestinations == 1 &&
            threatReport.Findings.Single() is { MatchedValue: "bad.example", Address: "203.0.113.8", RequestedName: "api.bad.example" } finding &&
            finding.FirstSeen == observedAt && finding.LastSeen == observedAt,
            "parent-domain findings retain address, requested name, and observation bounds while hostname-unavailable destinations remain explicit");
        geoStore.ReplaceThreatIndicators(true,
            [new ThreatIndicator("ip", "203.0.113.8", "ip-feed", "exact IP", "high"),
             new ThreatIndicator("domain", "bad.example", "domain-feed", "domain", "high")], "threat-etag-2", observedAt);
        Assert(geoStore.ReadThreatReport(observedAt.AddMinutes(-2), DateTimeOffset.UtcNow).Findings.Single().IndicatorKind == "ip",
            "exact IP remains higher priority than hostname and parent-domain matches");
    }

    Assert(new ProcessNameResolver().Resolve(Environment.ProcessId, DateTimeOffset.UtcNow) is { Length: > 0 },
        "current process name resolves");

    var requestId = Guid.NewGuid();
    var agentId = Guid.NewGuid();
    var claimProof = "egvc_" + new string('a', 64);
    var agentToken = "egva_" + new string('b', 64);
    var enrollmentHandler = new EnrollmentHandler(
        new(HttpStatusCode.Accepted, $"{{\"requestId\":\"{requestId}\",\"claimSecret\":\"{claimProof}\",\"expiresAt\":{DateTimeOffset.UtcNow.AddMinutes(10).ToUnixTimeMilliseconds()}}}"),
        new(HttpStatusCode.Created, $"{{\"status\":\"approved\",\"token\":\"{agentToken}\",\"agentId\":\"{agentId}\"}}"));
    var enrollment = new AgentEnrollmentClient(new HttpClient(enrollmentHandler));
    var ticket = await enrollment.ApplyAsync(new Uri("https://hub.example/"), " abc234 ",
        new(Environment.MachineName, "windows", Environment.OSVersion.VersionString, "0.1.0-dev"));
    Assert(ticket.RequestId == requestId && !ticket.ToString().Contains(claimProof, StringComparison.Ordinal), "enrollment returns a redacted pending ticket");
    var claim = await enrollment.ClaimOnceAsync(ticket);
    Assert(claim.Status == EnrollmentClaimStatus.Approved && claim.Credential?.AgentId == agentId, "approved enrollment returns the Agent credential");
    Assert(!claim.Credential!.ToString().Contains(agentToken, StringComparison.Ordinal), "credential text always redacts the token");
    Assert(!enrollmentHandler.SawAuthorization, "enrollment never sends an existing bearer");
    Assert(enrollmentHandler.SawUserAgent, "enrollment identifies the Windows Agent so standard WAF rules accept it");
    AgentCredential? savedCredential = null;
    var saveRequest = JsonSerializer.Serialize(new { v = 1, op = "save-enrollment", credential = claim.Credential });
    var saveResponse = IpcProtocol.Handle(saveRequest, () => "{}", _ => [], value => savedCredential = value);
    Assert(saveResponse.Contains("\"status\":\"ok\"", StringComparison.Ordinal) && savedCredential?.AgentId == agentId, "authenticated IPC accepts a validated credential without echoing it");
    Assert(!saveResponse.Contains(agentToken, StringComparison.Ordinal), "IPC never echoes the credential token");
    var failedSave = IpcProtocol.Handle(saveRequest, () => "{}", _ => [], _ => throw new IOException("vault unavailable"));
    Assert(failedSave.Contains("credential-storage-failed", StringComparison.Ordinal) && !failedSave.Contains(agentToken, StringComparison.Ordinal), "credential storage failure is actionable and secret-free");
    bool? deliveryEnabled = null;
    var enableResponse = IpcProtocol.Handle("""{"v":1,"op":"set-delivery-enabled","enabled":true}""", () => "{}", _ => [], null, value => deliveryEnabled = value);
    Assert(enableResponse.Contains("\"status\":\"ok\"", StringComparison.Ordinal) && deliveryEnabled == true, "authenticated IPC changes explicit delivery opt-in");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"set-delivery-enabled","enabled":"yes"}""", () => "{}", _ => [], null, _ => { }).Contains("invalid-delivery-setting", StringComparison.Ordinal),
        "delivery opt-in rejects ambiguous values");
    var enrichmentKind = string.Empty;
    var enrichmentStatus = IpcProtocol.Handle("""{"v":1,"op":"enrichment-status"}""", () => "{}", _ => [],
        enrichmentStatus: () => """{"policy":"hub-only"}""");
    Assert(enrichmentStatus.Contains("hub-only", StringComparison.Ordinal), "enrichment status is available over authenticated IPC");
    var enrichmentRefresh = IpcProtocol.Handle("""{"v":1,"op":"refresh-enrichment","kind":"geo"}""", () => "{}", _ => [],
        requestEnrichmentNow: kind => enrichmentKind = kind);
    Assert(enrichmentRefresh.Contains("\"status\":\"ok\"", StringComparison.Ordinal) && enrichmentKind == "geo",
        "manual enrichment refresh accepts only an explicit data kind");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"refresh-enrichment","kind":"public-feed"}""", () => "{}", _ => [],
        requestEnrichmentNow: _ => { }).Contains("invalid-enrichment-kind", StringComparison.Ordinal),
        "manual enrichment refresh cannot silently enable an external provider");
    var freshnessNow = DateTimeOffset.UtcNow;
    Assert(EnrichmentFreshness.Classify(null, TimeSpan.FromHours(1), freshnessNow) == "not-fetched" &&
        EnrichmentFreshness.Classify(freshnessNow.AddMinutes(-59), TimeSpan.FromHours(1), freshnessNow) == "current" &&
        EnrichmentFreshness.Classify(freshnessNow.AddMinutes(-61), TimeSpan.FromHours(1), freshnessNow) == "stale",
        "enrichment freshness never labels missing or expired cache data as current");
    await AssertEnrollmentFailure(() => enrollment.ApplyAsync(new Uri("http://hub.example/"), "ABC234",
        new("host", "windows", "Windows", "dev")), "invalid-hub-url", "plaintext remote Hub is rejected client-side");

    var deliveryDatabase = Path.Combine(directory, "delivery.db");
    var deliveryStarted = DateTimeOffset.UtcNow;
    Guid activeBatchId;
    using (var deliveryStore = new ObservationStore(deliveryDatabase))
    {
        var flow = new NetworkObservation(deliveryStarted, 77, "TCP", "10.0.0.1", 50000, "203.0.113.8", 443,
            120, 80, ObservationLayer.Logical, "if", "etw", "Browser");
        deliveryStore.QueueForDelivery([flow, flow with { ObservedAt = deliveryStarted.AddSeconds(1), BytesSent = 30, BytesReceived = 20 }], deliveryStarted);
        deliveryStore.QueueForDelivery([
            flow with { RemotePort = 0 },
            flow with { Layer = ObservationLayer.VpnTransport, ProcessName = "tailscaled" },
        ], deliveryStarted);
        var status = deliveryStore.ReadDeliveryStatus();
        Assert(status == new DeliveryQueueStatus(1, 1, 0, deliveryStarted, null), "delivery queue aggregates a logical flow, rejects invalid data, and excludes VPN transport");
        var batch = deliveryStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(2))!;
        activeBatchId = batch.BatchId;
        Assert(batch.Observations.Count == 1 && batch.Observations[0].BytesOut == 150 && batch.Observations[0].BytesIn == 100, "delivery batch preserves exact aggregate bytes");
        Assert(deliveryStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(3))!.BatchId == activeBatchId, "unacknowledged retry preserves the batch ID");
    }
    using (var reopenedDelivery = new ObservationStore(deliveryDatabase))
    {
        Assert(reopenedDelivery.PrepareDeliveryBatch(deliveryStarted.AddSeconds(4))!.BatchId == activeBatchId, "active batch survives service restart");
        reopenedDelivery.AcknowledgeDelivery(activeBatchId, deliveryStarted.AddSeconds(5));
        Assert(reopenedDelivery.ReadDeliveryStatus().Pending == 0 && reopenedDelivery.ReadDeliveryStatus().LastAcknowledgedAt == deliveryStarted.AddSeconds(5), "ACK removes only the matching durable batch");
    }
    using (var senderStore = new ObservationStore(Path.Combine(directory, "sender.db")))
    {
        senderStore.QueueForDelivery([new NetworkObservation(deliveryStarted, 88, "UDP", "10.0.0.1", 53000,
            "203.0.113.9", 443, 42, 24, ObservationLayer.Logical, "if", "etw", "Browser")], deliveryStarted);
        var deliveryHandler = new DeliveryHandler(500, 429, 200);
        var sender = new DeliverySender(new HttpClient(deliveryHandler));
        var credential = new AgentCredential(new Uri("https://hub.example/"), agentId, agentToken, deliveryStarted);
        var metadata = new DeliveryMetadata("host", "windows", "Windows", "dev");
        Assert((await sender.SendNextAsync(senderStore, credential, metadata)).Kind == DeliveryAttemptKind.Retryable, "5xx keeps the durable batch for retry");
        var limited = await sender.SendNextAsync(senderStore, credential, metadata);
        Assert(limited.Kind == DeliveryAttemptKind.RateLimited && limited.RetryAfter == TimeSpan.FromSeconds(7), "429 honors Retry-After without dropping data");
        Assert((await sender.SendNextAsync(senderStore, credential, metadata)).Kind == DeliveryAttemptKind.Acknowledged, "matching ACK removes the batch");
        Assert(senderStore.ReadDeliveryStatus().Pending == 0 && deliveryHandler.BatchIds.Distinct().Count() == 1, "all retries use the same idempotent batch ID");
        Assert(deliveryHandler.SawEtwCollector && deliveryHandler.SawProcessId && deliveryHandler.SawBearer && deliveryHandler.SawUserAgent,
            "Windows payload, Agent bearer, and User-Agent match the Hub contract");
    }
    using (var rejectedStore = new ObservationStore(Path.Combine(directory, "sender-rejected.db")))
    {
        rejectedStore.QueueForDelivery([new NetworkObservation(deliveryStarted, 89, "TCP", "10.0.0.1", 53001,
            "203.0.113.10", 443, 12, 8, ObservationLayer.Logical, "if", "etw", "Browser")], deliveryStarted);
        var handler = new DeliveryHandler(200, 200) { RejectedAcknowledgements = 1 };
        var sender = new DeliverySender(new HttpClient(handler));
        var credential = new AgentCredential(new Uri("https://hub.example/"), agentId, agentToken, deliveryStarted);
        var metadata = new DeliveryMetadata("host", "windows", "Windows", "dev");
        Assert((await sender.SendNextAsync(rejectedStore, credential, metadata)).Kind == DeliveryAttemptKind.Rejected,
            "a Hub-rejected row keeps the durable batch for retry");
        Assert(rejectedStore.ReadDeliveryStatus().Pending == 1, "rejected ACK does not drop Windows observations");
        Assert((await sender.SendNextAsync(rejectedStore, credential, metadata)).Kind == DeliveryAttemptKind.Acknowledged,
            "the same durable batch can be accepted after the Hub contract is fixed");
        Assert(handler.BatchIds.Distinct().Count() == 1, "a rejected ACK preserves the idempotent batch ID");
    }

    var fallback = AgentCapabilityNegotiation.Decide(null);
    Assert(fallback.Kind == AgentCapabilityOutcomeKind.Unknown && fallback.SchemaVersion == 1 &&
        fallback.BatchSize == 200 && !fallback.IncludeRemoteHostname,
        "an unavailable capability endpoint keeps legacy schema v1 without optional fields");
    var negotiated = AgentCapabilityNegotiation.Decide(new AgentHubCapabilities([1], 2,
        ObservationFields: ["remoteHostname"]));
    Assert(negotiated.Kind == AgentCapabilityOutcomeKind.Agreed && negotiated.BatchSize == 2 && negotiated.IncludeRemoteHostname,
        "capability negotiation honors the Hub batch limit and explicit hostname field");
    Assert(AgentCapabilityNegotiation.Decide(new AgentHubCapabilities([2])).Kind == AgentCapabilityOutcomeKind.Incompatible,
        "an explicit capability answer with no common schema is incompatible");

    using (var capableStore = new ObservationStore(Path.Combine(directory, "sender-capable.db")))
    {
        for (var index = 0; index < 3; index++)
            capableStore.QueueForDelivery([new NetworkObservation(deliveryStarted.AddSeconds(index), 120 + index, "TCP",
                "10.0.0.1", 55000 + index, "203.0.113.20", 443, 10, 20, ObservationLayer.Logical, "if", "etw",
                "Browser", $"cdn{index}.example")], deliveryStarted.AddSeconds(index));
        var handler = new DeliveryHandler(200, 200)
        {
            CapabilitiesStatus = HttpStatusCode.OK,
            CapabilitiesJson = """{"schemaVersions":[1],"maxObservationsPerBatch":2,"observationFields":["remoteHostname"]}""",
        };
        var clock = new ManualTimeProvider(deliveryStarted);
        var sender = new DeliverySender(new HttpClient(handler), clock);
        var credential = new AgentCredential(new Uri("https://hub.example/"), agentId, agentToken, deliveryStarted);
        var metadata = new DeliveryMetadata("host", "windows", "Windows", "dev");
        Assert((await sender.SendNextAsync(capableStore, credential, metadata)).Kind == DeliveryAttemptKind.Acknowledged,
            "a compatible Hub accepts the first bounded batch");
        Assert(handler.ObservationCounts.Single() == 2 && handler.SawRemoteHostname,
            "only the negotiated batch limit is sent and stored hostnames reach an accepting Hub");
        using (var payload = JsonDocument.Parse(handler.LastIngestBody!))
        {
            var root = payload.RootElement;
            var sentKeys = root.EnumerateObject().Select(item => item.Name)
                .Concat(root.GetProperty("agent").EnumerateObject().Select(item => item.Name))
                .Concat(root.GetProperty("observations")[0].EnumerateObject().Select(item => item.Name))
                .ToHashSet(StringComparer.Ordinal);
            foreach (var language in new[] { "en", "ja" })
            {
                var resource = XDocument.Load(Path.Combine(windowsRoot, "src", "EgressView.Agent.Ui", "Resources", $"Strings.{language}.xaml"));
                var disclosure = resource.Descendants().Single(node =>
                    (string?)node.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml")) == "HubExplanation").Value;
                var disclosedKeys = Regex.Matches(disclosure, @"\[([A-Za-z][A-Za-z0-9]*)\]")
                    .Select(match => match.Groups[1].Value).ToHashSet(StringComparer.Ordinal);
                Assert(disclosedKeys.SetEquals(sentKeys),
                    $"{language} Hub disclosure must match the actual serialized sender payload, including optional hostname");
            }
            foreach (var path in new[] { "README.md", "README.en.md" })
            {
                var guide = File.ReadAllText(Path.Combine(windowsRoot, path));
                Assert(sentKeys.All(key => guide.Contains($"`{key}`", StringComparison.Ordinal)),
                    $"{path} lists every key in the sent JSON payload");
            }
            var downloadPage = File.ReadAllText(Path.Combine(windowsRoot, "..", "..", "site", "dl", "index.html"));
            Assert(sentKeys.All(key => downloadPage.Contains(key, StringComparison.Ordinal)),
                "the download page lists every key in the sent JSON payload");
            var updateAgent = WindowsAgentUpdateClient.UserAgent("1.2.3", "11.0");
            Assert(updateAgent.Contains("1.2.3", StringComparison.Ordinal) && updateAgent.Contains("11.0", StringComparison.Ordinal) &&
                downloadPage.Contains("dl.egressview.com", StringComparison.Ordinal) &&
                File.ReadAllText(Path.Combine(windowsRoot, "README.md")).Contains("dl.egressview.com", StringComparison.Ordinal) &&
                File.ReadAllText(Path.Combine(windowsRoot, "README.en.md")).Contains("dl.egressview.com", StringComparison.Ordinal),
                "update-check disclosure names the actual origin and User-Agent version fields");
        }
        Assert((await sender.SendNextAsync(capableStore, credential, metadata)).Kind == DeliveryAttemptKind.Acknowledged &&
            handler.CapabilityRequests == 1 && handler.ObservationCounts.Last() == 1,
            "successful capabilities are cached while later batches preserve the negotiated limit");
    }

    using (var legacyStore = new ObservationStore(Path.Combine(directory, "sender-legacy.db")))
    {
        legacyStore.QueueForDelivery([new NetworkObservation(deliveryStarted, 130, "TCP", "10.0.0.1", 56000,
            "203.0.113.30", 443, 1, 2, ObservationLayer.Logical, "if", "etw", "Browser", "private.example")], deliveryStarted);
        var handler = new DeliveryHandler(200);
        var clock = new ManualTimeProvider(deliveryStarted);
        var sender = new DeliverySender(new HttpClient(handler), clock);
        var credential = new AgentCredential(new Uri("https://legacy.example/"), agentId, agentToken, deliveryStarted);
        Assert((await sender.SendNextAsync(legacyStore, credential, new("host", "windows", "Windows", "dev"))).Kind == DeliveryAttemptKind.Acknowledged &&
            !handler.SawRemoteHostname && sender.CapabilityStatus.State == "unavailable",
            "an old Hub 404 keeps delivery working and never receives a hostname");
        handler.CapabilitiesStatus = HttpStatusCode.OK;
        handler.CapabilitiesJson = """{"schemaVersions":[1],"maxObservationsPerBatch":200,"observationFields":["remoteHostname"]}""";
        Assert((await sender.SendNextAsync(legacyStore, credential, new("host", "windows", "Windows", "dev"))).Kind == DeliveryAttemptKind.Empty &&
            handler.CapabilityRequests == 1, "a failed capability lookup is not retried on every delivery pass");
        clock.Advance(TimeSpan.FromHours(1) + TimeSpan.FromSeconds(1));
        await sender.SendNextAsync(legacyStore, credential, new("host", "windows", "Windows", "dev"));
        Assert(handler.CapabilityRequests == 2 && sender.CapabilityStatus.State == "agreed",
            "a failed capability lookup is retried on the low-frequency refresh interval");
    }

    using (var incompatibleStore = new ObservationStore(Path.Combine(directory, "sender-incompatible.db")))
    {
        incompatibleStore.QueueForDelivery([new NetworkObservation(deliveryStarted, 140, "TCP", "10.0.0.1", 57000,
            "203.0.113.40", 443, 1, 2, ObservationLayer.Logical, "if", "etw", "Browser", "blocked.example")], deliveryStarted);
        var handler = new DeliveryHandler { CapabilitiesStatus = HttpStatusCode.OK, CapabilitiesJson = """{"schemaVersions":[2]}""" };
        var sender = new DeliverySender(new HttpClient(handler));
        var result = await sender.SendNextAsync(incompatibleStore,
            new(new Uri("https://future.example/"), agentId, agentToken, deliveryStarted), new("host", "windows", "Windows", "dev"));
        Assert(result.Kind == DeliveryAttemptKind.Incompatible && handler.IngestRequests == 0 && incompatibleStore.ReadDeliveryStatus().Pending == 1,
            "an explicit schema mismatch stops before ingest and preserves the durable queue");
    }

    var optInDatabase = Path.Combine(directory, "delivery-opt-in.db");
    using (var optInStore = new ObservationStore(optInDatabase))
    {
        var observation = new NetworkObservation(deliveryStarted, 99, "TCP", "10.0.0.1", 54000,
            "203.0.113.10", 443, 10, 20, ObservationLayer.Logical, "if", "etw", "Browser");
        await using (var disabledPipeline = new ObservationPipeline(optInStore, deliveryEnabled: () => optInStore.DeliveryEnabled))
            Assert(disabledPipeline.TrySubmit(observation), "collection remains active while delivery is off");
        Assert(optInStore.ReadDeliveryStatus().Pending == 0, "delivery off does not queue observations");
        optInStore.DeliveryEnabled = true;
        await using (var enabledPipeline = new ObservationPipeline(optInStore, deliveryEnabled: () => optInStore.DeliveryEnabled))
            Assert(enabledPipeline.TrySubmit(observation), "opted-in observation is accepted");
        Assert(optInStore.ReadDeliveryStatus().Pending == 1, "delivery on queues persisted observations");
    }
    using (var reopenedOptIn = new ObservationStore(optInDatabase))
        Assert(reopenedOptIn.DeliveryEnabled, "explicit delivery opt-in survives service restart");

    using (var summaryStore = new ObservationStore(Path.Combine(directory, "summary.db")))
    {
        var hour = new DateTimeOffset(2026, 8, 30, 1, 0, 0, TimeSpan.Zero);
        summaryStore.WriteBatch(new[]
        {
            new NetworkObservation(hour.AddMinutes(1), 1, "TCP", "10.0.0.1", 1, "10.0.0.2", 443, 10, 20, ObservationLayer.Logical, null, "etw"),
            new NetworkObservation(hour.AddMinutes(2), 1, "TCP", "10.0.0.1", 1, "10.0.0.2", 443, null, null, ObservationLayer.Logical, null, "etw"),
        });
        var summary = summaryStore.ReadHourlySummary(hour, hour.AddHours(1)).Single();
        Assert(summary.ObservationCount == 2 && summary.BytesSent == 10 && summary.BytesReceived == 20 && summary.BytesUnknown == 1,
            "hourly summary preserves counts, bytes, and unknown bytes");
    }

    var corruptDatabase = Path.Combine(directory, "corrupt.db");
    File.WriteAllBytes(corruptDatabase, "this is not a sqlite database"u8.ToArray());
    AssertStoreFailure(() => new ObservationStore(corruptDatabase), StoreFailureKind.Corrupt,
        "corrupt database fails closed instead of being recreated");

    var fullDatabase = Path.Combine(directory, "full.db");
    using (var fullStore = new ObservationStore(fullDatabase))
    {
        fullStore.LimitGrowthForTesting(1);
        var largeBatch = Enumerable.Range(0, 10_000).Select(index => new NetworkObservation(
            DateTimeOffset.UtcNow, 8, "UDP", "127.0.0.1", 40_000 + index,
            "127.0.0.2", 443, 1, 0, ObservationLayer.Logical, null, "etw")).ToArray();
        AssertStoreFailure(() => fullStore.WriteBatch(largeBatch, queueForDelivery: true), StoreFailureKind.DiskFull,
            "disk full is classified explicitly");
        Assert(fullStore.Inspect().Count == 0 && fullStore.ReadDeliveryStatus().Pending == 0,
            "disk-full batch atomically rolls back local history and delivery queue");
    }

    var pipelineFullDatabase = Path.Combine(directory, "pipeline-full.db");
    using (var pipelineFullStore = new ObservationStore(pipelineFullDatabase))
    {
        pipelineFullStore.LimitGrowthForTesting(1);
        var fullPipeline = new ObservationPipeline(pipelineFullStore, capacity: 2_000, batchSize: 2_000);
        for (var index = 0; index < 2_000; index++)
            Assert(fullPipeline.TrySubmit(new NetworkObservation(DateTimeOffset.UtcNow, 8, "UDP",
                "127.0.0.1", 40_000 + index, "127.0.0.2", 443, 1, 0,
                ObservationLayer.Logical, null, "etw")), "pre-failure observation accepted");
        await fullPipeline.DisposeAsync();
        var failedSnapshot = fullPipeline.Snapshot();
        Assert(failedSnapshot.PersistenceFailures == 1 && failedSnapshot.PersistenceError == "disk-full",
            "pipeline exposes disk-full reason");
        Assert(!fullPipeline.TrySubmit(new NetworkObservation(DateTimeOffset.UtcNow, 8, "UDP",
            "127.0.0.1", 1, "127.0.0.2", 443, 1, 0, ObservationLayer.Logical, null, "etw")),
            "pipeline stops accepting after persistence failure");
    }

    if (args.Contains("--million", StringComparer.OrdinalIgnoreCase))
    {
        var scaleDatabase = Path.Combine(directory, "million.db");
        var started = DateTimeOffset.UtcNow;
        using var scaleStore = new ObservationStore(scaleDatabase);
        for (var offset = 0; offset < 1_000_000; offset += 1_000)
        {
            var batch = Enumerable.Range(offset, 1_000).Select(index => new NetworkObservation(
                started.AddSeconds(index * (30d * 24 * 60 * 60 / 1_000_000)), 9, "TCP", "10.0.0.1", 50_000,
                "10.0.0.2", 443, 1, 1, ObservationLayer.Logical, "scale", "etw")).ToArray();
            scaleStore.WriteBatch(batch);
        }
        var scale = scaleStore.Inspect();
        Assert(scale.Count == 1_000_000 && scale.Integrity == "ok", "one-million-row database remains complete and valid");
        var queryStarted = DateTimeOffset.UtcNow;
        var thirtyDays = scaleStore.ReadHourlySummary(started, started.AddDays(31));
        var queryMilliseconds = (DateTimeOffset.UtcNow - queryStarted).TotalMilliseconds;
        Assert(thirtyDays.Sum(row => row.ObservationCount) == 1_000_000, "30-day summary covers all million observations");
        Assert(queryMilliseconds < 1_000, "30-day summary query completes under one second");
        var foldStarted = DateTimeOffset.UtcNow;
        scaleStore.FoldCompletedHoursForCharts(started.AddDays(31));
        var foldMilliseconds = (DateTimeOffset.UtcNow - foldStarted).TotalMilliseconds;
        var timelineStarted = DateTimeOffset.UtcNow;
        var scaleTimeline = scaleStore.ReadPeriodAnalysis(started, started.AddDays(30), bucketCount: 60);
        var timelineMilliseconds = (DateTimeOffset.UtcNow - timelineStarted).TotalMilliseconds;
        Assert(scaleTimeline.Timeline.Sum(row => row.Connections) == 1_000_000,
            "30-day timeline preserves all observation-time counts after folding");
        Assert(timelineMilliseconds < 1_000, "30-day timeline aggregate query completes under one second");
        Console.WriteLine($"SCALE: 1,000,000 rows, summary {queryMilliseconds:F1}ms, one-time chart fold {foldMilliseconds:F1}ms, timeline {timelineMilliseconds:F1}ms, {new FileInfo(scaleDatabase).Length} bytes");
    }

    // Process names outlive the process. Without this the name is lost the
    // moment a short-lived process exits, and every later observation of the
    // same flow is dropped before delivery because the Hub requires a name.
    {
        var now = DateTimeOffset.UtcNow;
        var started = now.AddMinutes(-1);
        var alive = true;
        var resolver = new ProcessNameResolver(
            TimeSpan.FromMinutes(2),
            pid => alive && pid == 4242 ? new ProcessNameResolver.LiveProcess("beacon.exe", started) : null);

        Assert(resolver.Resolve(4242, now) == "beacon.exe", "a live process resolves");
        alive = false;
        Assert(resolver.Resolve(4242, now.AddSeconds(30)) == "beacon.exe",
            "the name survives the process for observations inside the window");
        Assert(resolver.CacheHits == 1, "the surviving answer came from the cache");
        Assert(resolver.Resolve(4242, now.AddMinutes(10)) is null,
            "the name is not reused indefinitely after the process is gone");
        Assert(resolver.Expired == 1, "expiry is counted rather than silent");

        // A PID handed to a different process must not inherit the old name.
        // A wrong name is worse than none: a missing name is visibly missing,
        // a wrong one is indistinguishable from a correct one.
        var reused = new ProcessNameResolver(
            TimeSpan.FromMinutes(2),
            pid => alive ? new ProcessNameResolver.LiveProcess("first.exe", started) : null);
        alive = true;
        Assert(reused.Resolve(77, now) == "first.exe", "the first user of the PID resolves");
        alive = false;
        Assert(reused.Resolve(77, started.AddMinutes(-5)) is null,
            "an observation older than the cached process is refused");
        Assert(reused.PidReuseRejected == 1, "PID reuse is counted rather than silent");

        // A process start event names the process before any of its traffic
        // is seen, which is the only way to name one that exits before its
        // first event is processed.
        var aliveForLearn = true;
        var fromStart = new ProcessNameResolver(TimeSpan.FromMinutes(2), _ => null);
        fromStart.Observe(9001, @"\Device\HarddiskVolume4\Windows\System32\curl.exe", started);
        Assert(fromStart.Resolve(9001, now) == "curl",
            "a process that never answered a query is still named from its start event");
        Assert(fromStart.ObservedStarts == 1, "names learned from start events are counted");
        Assert(fromStart.Resolve(9001, started.AddMinutes(-1)) is null,
            "a start event does not name observations that predate the process");

        // ProcessStart carries no image name, so the name has to be queried at
        // that instant. This is the path that was silently doing nothing when
        // it looked for a field the start event does not have.
        var learned = new ProcessNameResolver(
            TimeSpan.FromMinutes(2),
            pid => pid == 5150 && aliveForLearn
                ? new ProcessNameResolver.LiveProcess("installer", started)
                : null);
        learned.Learn(5150, started);
        Assert(learned.ObservedStarts == 1, "a start event names the process by querying it while it is alive");
        aliveForLearn = false;
        Assert(learned.Resolve(5150, now) == "installer",
            "the learned name survives the process that has since exited");

        var missed = new ProcessNameResolver(TimeSpan.FromMinutes(2), _ => null);
        missed.Learn(5151, started);
        Assert(missed.ObservedStarts == 0, "a start for a process already gone teaches nothing");
        Assert(missed.Resolve(5151, now) is null && missed.NeverSeenAfterStartup == 1,
            "a process whose start was seen but could not be queried is classified after startup");
        Assert(missed.NeverSeenAfterStartProbeMiss == 1 && missed.NeverSeenWithoutStartEvent == 0,
            "a missed live query is distinguished from a lifecycle event that never arrived");

        var noStartEvent = new ProcessNameResolver(TimeSpan.FromMinutes(2), _ => null);
        Assert(noStartEvent.Resolve(5252, now) is null && noStartEvent.NeverSeenWithoutStartEvent == 1,
            "a post-startup PID with no lifecycle event is classified separately");

        var startupMiss = new ProcessNameResolver(TimeSpan.FromMinutes(2), _ => null, [6161]);
        Assert(startupMiss.Resolve(6161, now) is null, "a process present at startup can remain nameless");
        Assert(startupMiss.NeverSeen == 1 && startupMiss.NeverSeenAtStartup == 1
            && startupMiss.NeverSeenAfterStartup == 0,
            "never-seen observations identify the startup snapshot gap");
        startupMiss.Learn(6161, started);
        Assert(startupMiss.Resolve(6161, now) is null && startupMiss.NeverSeenAfterStartup == 1,
            "a later lifecycle start removes a reused PID from the startup population");

        Assert(ProcessNameResolver.BareName(@"C:\Program Files\Vendor\app.exe") == "app",
            "a path becomes the bare name Process.ProcessName would give");
        Assert(ProcessNameResolver.BareName("svchost.exe") == "svchost", "an extension is dropped");
        Assert(ProcessNameResolver.BareName("") is null, "an empty image name is not a name");

        var invalidPid = new ProcessNameResolver();
        Assert(invalidPid.Resolve(0, now) is null && invalidPid.InvalidProcessId == 1,
            "PID 0 has no name and is classified separately");
        Assert(new ProcessNameResolver().Resolve(Environment.ProcessId, now) is not null,
            "the running test process resolves through the real probe");
    }

    // A process too short-lived for the ProcessStart callback's live query is
    // held briefly. ProcessStop supplies the real image name; matching the
    // create time prevents a reused PID from naming the wrong observation.
    {
        var now = DateTimeOffset.UtcNow;
        NetworkObservation Observation(int pid) => new(now, pid, "TCP", "192.0.2.2", 5000,
            "203.0.113.8", 443, 10, 0, ObservationLayer.Logical, null, "etw");
        var deferred = new DeferredProcessObservations(TimeSpan.FromSeconds(2), capacity: 2);
        Assert(deferred.TryDefer(Observation(7001), now.AddSeconds(-1), now), "nameless observation is deferred");
        Assert(deferred.Complete(7001, now.AddSeconds(-2), "wrong").Count == 0,
            "the same reused PID with a different start time cannot name it");
        var recovered = deferred.Complete(7001, now.AddSeconds(-1), "curl");
        Assert(recovered.Count == 1 && recovered[0].ProcessName == "curl",
            "ProcessStop recovers the exact process observation");
        Assert(deferred.Deferred == 1 && deferred.Recovered == 1 && deferred.Pending == 0,
            "defer and recovery are visible in diagnostics");

        Assert(deferred.TryDefer(Observation(7002), now, now), "a second observation is deferred");
        var expired = deferred.Expire(now.AddSeconds(2));
        Assert(expired.Count == 1 && expired[0].ProcessName is null && deferred.Expired == 1,
            "an absent stop event releases the observation nameless after the bound");

        Assert(deferred.TryDefer(Observation(7003), now, now), "capacity slot one is used");
        Assert(deferred.TryDefer(Observation(7003), now, now), "capacity slot two is used");
        Assert(!deferred.TryDefer(Observation(7003), now, now) && deferred.Overflow == 1,
            "the bounded buffer refuses and counts overflow");
        Assert(deferred.Drain().Count == 2 && deferred.Pending == 0,
            "shutdown drains observations instead of losing them");

        // ETW callbacks can be delayed by load even though their event times
        // are close together. Expiry follows the event timeline, not callback
        // wall time, and ProcessStop completion gets the first chance to name
        // an observation at the boundary.
        var delayed = new DeferredProcessObservations(TimeSpan.FromSeconds(10));
        Assert(delayed.TryDefer(Observation(7004), now, now), "a delayed callback observation is deferred");
        Assert(delayed.Expire(now.AddSeconds(9)).Count == 0,
            "callback latency does not expire an observation before its event-time deadline");
        Assert(delayed.Complete(7004, now, "worker").Single().ProcessName == "worker",
            "a delayed ProcessStop still supplies the exact name before expiry");
    }

    // A rejection total says how much never reaches the Hub. Only the reason
    // says what to fix: a name that could be recovered and a port that never
    // can are indistinguishable in a single counter.
    {
        var reasonsDatabase = Path.Combine(directory, "reasons.db");
        using var store = new ObservationStore(reasonsDatabase);
        store.DeliveryEnabled = true;
        var at = DateTimeOffset.UtcNow;
        NetworkObservation Observation(string? name, int remotePort = 443, string remote = "203.0.113.7", int pid = 10) =>
            new(at, pid, "TCP", "192.0.2.5", 5000, remote, remotePort, 1, 0,
                ObservationLayer.Logical, null, "etw", name);

        store.QueueForDelivery([
            Observation("good"),
            Observation(null),
            Observation(""),
            Observation("bad", remotePort: 0),
            Observation("bad", remote: "not-an-address"),
        ], at);

        var counters = store.ReadCounters();
        long Counter(string reason) => counters!.TryGetValue($"contract-rejected-{reason}", out var value) ? value : 0;
        Assert(Counter("process-name") == 2, "a missing and an empty name are both counted as the name");
        Assert(Counter("remote-port") == 1, "an out-of-range remote port is counted separately");
        Assert(Counter("remote-address") == 1, "an unparseable remote address is counted separately");

        Assert(store.ReadDeliveryStatus().ContractRejected == 4, "the total still counts every rejection");
        Assert(store.ReadDeliveryStatus().Pending == 1, "the deliverable observation is still queued");
        Assert(counters.Keys.All(key => !key.Contains("203.0.113.7", StringComparison.Ordinal)),
            "reason counters name the failing part of the contract, never the value");
        // An inbound multicast observation has no local address by design. It
        // is named for what it is, so that a deliberate omission is not read as
        // a malformed observation.
        store.QueueForDelivery([
            new NetworkObservation(at, 10, "UDP", "", 5353, "224.0.0.251", 5353, 0, 1,
                ObservationLayer.Logical, null, "etw", "mdns"),
        ], at);
        counters = store.ReadCounters();
        Assert(Counter("inbound-multicast-no-local-address") == 1,
            "a deliberate omission is named as one, not as a malformed address");
        Assert(Counter("local-address") == 0,
            "the deliberate omission does not inflate the malformed-address count");
        Assert(store.ReadDeliveryStatus().ContractRejected == 5,
            "the deliberate omission is still counted in the total that says how much never arrives");
    }

    {
        // A straight line between two points on a projected globe is not the
        // route between them on a sphere. Tokyo to San Francisco passes far
        // north of the line joining them, and drawing the line instead would
        // put the traffic over ocean it never crosses.
        var tokyo = (35.68, 139.69);
        var sanFrancisco = (37.77, -122.42);
        var arc = GreatCircle.Path(tokyo, sanFrancisco);
        Assert(arc.Length == 49, "the arc is sampled at the requested resolution");
        Assert(Math.Abs(arc[0].Latitude - 35.68) < 0.01 && Math.Abs(arc[0].Longitude - 139.69) < 0.01,
            "the arc starts at the origin");
        Assert(Math.Abs(arc[^1].Latitude - 37.77) < 0.01 && Math.Abs(arc[^1].Longitude + 122.42) < 0.01,
            "the arc ends at the destination");
        var midpoint = arc[arc.Length / 2];
        Assert(midpoint.Latitude > 45, "the great circle bends poleward rather than running straight");
        Assert(Math.Abs(midpoint.Longitude) > 170, "the great circle crosses the date line rather than the Atlantic");

        Assert(GreatCircle.Path(tokyo, tokyo).Length == 2,
            "an arc to the same place is two points rather than a division by zero");

        // Home is the one place that must not be squashed against the rim,
        // because every arc starts there.
        Assert(HomeLocation.PreferredTilt(35.68) > 0 && HomeLocation.PreferredTilt(-35.28) < 0,
            "the globe tips towards the hemisphere the traffic leaves from");
        Assert(HomeLocation.Current("JP") == (35.68, 139.69), "a known region places home there");
        Assert(HomeLocation.Current("ZZ") == HomeLocation.Current("JP"),
            "an unknown region falls back rather than landing at null island");
    }

    {
        // A process that crashes writes nothing, so its fate has to be decided
        // by the next start. The failure mode to avoid is the opposite one:
        // reporting a crash that never happened is a lie the user will act on.
        var runDatabase = Path.Combine(directory, "run-history.db");
        using (var first = new ObservationStore(runDatabase))
        {
            var run = first.BeginRun(RunComponent.Service, "0.1.0");
            first.Heartbeat(run);
            first.EndRun(run);
        }
        using (var second = new ObservationStore(runDatabase))
        {
            var clean = second.ReadRunHistory();
            Assert(clean.Count == 1 && clean[0].Ending == "clean",
                "a run that closed itself is recorded as clean");
            // Opened and abandoned, the way a killed process leaves it.
            second.BeginRun(RunComponent.Service, "0.1.0");
        }
        using (var third = new ObservationStore(runDatabase))
        {
            third.BeginRun(RunComponent.Service, "0.1.0");
            var history = third.ReadRunHistory();
            Assert(history.Count == 3, "each start is its own run");
            Assert(history[0].Ending == "running", "the current run is open");
            Assert(history[1].Ending == "unexpected",
                "a run still open when the next one starts is recorded as an unexpected end");
            Assert(history[2].Ending == "clean",
                "settling the abandoned run does not disturb the one that ended properly");
            Assert(history[1].EndedAt == history[1].HeartbeatAt,
                "an unexpected end is dated to the last sign of life, not to when it was noticed");

            // The two processes are told apart, and one ending does not settle
            // the other: the user's first question is which half stopped.
            var ui = third.BeginRun(RunComponent.Ui, "0.1.0");
            Assert(third.ReadRunHistory()[1].Ending == "running",
                "starting the window does not close the service's run");
            third.FaultRun(ui, "System.InvalidOperationException");
            var faulted = third.ReadRunHistory()[0];
            Assert(faulted.Component == RunComponent.Ui && faulted.Ending == "faulted" &&
                faulted.Fault == "System.InvalidOperationException",
                "a caught crash records which process it was and what kind of failure");

            // A message can carry a path with an account name in it, a host
            // name, or a destination. The bundle promises to carry none.
            var poisoned = third.BeginRun(RunComponent.Ui, "0.1.0");
            third.FaultRun(poisoned, @"System.IO.IOException: C:\Users\person\secret to 10.1.2.3");
            Assert(third.ReadRunHistory()[0].Fault == "System.IO.IOException",
                "a fault record keeps the type name and drops everything a message could carry");


            var report = DiagnosticsReport.Create(
                new CollectorSnapshot("healthy", 0, 0, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0),
                third, "0.1.0");
            Assert(report.Contains("unexpected", StringComparison.Ordinal) &&
                report.Contains("faulted", StringComparison.Ordinal),
                "the diagnostics bundle carries what happened to previous runs");
            Assert(!report.Contains("person", StringComparison.Ordinal) &&
                !report.Contains("10.1.2.3", StringComparison.Ordinal),
                "the diagnostics bundle carries no path, account or destination from a crash");
        }
    }

    {
        // The Mac Agent's settings file carries fields this one has never had,
        // and its own source says a value that is neither applied nor named as
        // ignored must not exist. Windows used to drop them silently while
        // reporting how many settings it had applied.
        var fromMac = System.Text.Encoding.UTF8.GetBytes("""
            {"version":1,"language":"japanese","retentionDays":30,
             "hubDeliveryEnabled":true,"readServerNameFromHandshake":false}
            """);
        var (settings, ignored) = AgentSettingsFile.Read(fromMac);
        Assert(settings.Language == "japanese" && settings.RetentionDays == 30,
            "a settings file written elsewhere still applies the fields this Agent shares");
        Assert(ignored.SequenceEqual(["hubDeliveryEnabled", "readServerNameFromHandshake"]),
            "fields this Agent has no setting for are named, not dropped in silence");

        var ours = AgentSettingsFile.Encode(new AgentSettingsFile(AgentSettingsFile.CurrentSchemaVersion, Language: "english"));
        Assert(AgentSettingsFile.Read(ours).Ignored.Count == 0,
            "a file this Agent wrote itself reports nothing ignored");
    }

    {
        // Ported from the Mac Agent with its thresholds intact. The same
        // laptop must not be called unusual on one platform and ordinary on
        // the other, so these assertions mirror the Swift tests case for case.
        const ulong mib = 1024 * 1024;
        static OutboundTrafficWindow Window(int index, ulong megabytes, int observationsWithBytes = 100,
            int applications = 2, int destinations = 5, ulong? largestAppMegabytes = null) =>
            new(new DateTimeOffset(2027, 1, 1, 0, 0, 0, TimeSpan.Zero).AddSeconds(index * 900),
                megabytes * 1024 * 1024, 100, observationsWithBytes, applications, destinations,
                (largestAppMegabytes ?? megabytes) * 1024 * 1024);

        var detector = new OutboundAnomalyDetector();

        // Under a day of history, "normal" has not been observed, only
        // guessed at. Refusing to decide is the answer, not a missing one.
        Assert(detector.Evaluate(Window(96, 500), Enumerable.Range(0, 95).Select(i => Window(i, 10)).ToArray()) is null,
            "no opinion is offered before a full day of measured baseline");

        var steady = Enumerable.Range(0, 96).Select(index => Window(index, 20)).ToArray();
        var large = detector.Evaluate(Window(96, 200), steady);
        Assert(large is { Kind: OutboundAnomalyKind.LargeTransfer } &&
            large.BaselineMedianBytesOut == 20 * mib && large.AlertThresholdBytesOut == 100 * mib,
            "a large send against a steady baseline is reported with the median and threshold that decided it");

        // Twelve destinations across five applications, none of them dominant:
        // the shape nobody finds by sorting a list by size.
        Assert(detector.Evaluate(Window(96, 300, applications: 5, destinations: 30, largestAppMegabytes: 120), steady)
            is { Kind: OutboundAnomalyKind.DistributedTransfer },
            "traffic spread across applications and destinations is told apart from one big sender");

        // A quiet baseline must not turn a small upload into an alarm: three
        // times almost nothing is still almost nothing.
        Assert(detector.Evaluate(Window(96, 40), Enumerable.Range(0, 96).Select(index => Window(index, 1)).ToArray()) is null,
            "the absolute floor keeps a quiet machine from alarming over a small upload");

        // A window that could not be measured is not evidence of a quiet
        // period. It must not alert, and it must not lower the baseline.
        var lenient = new OutboundAnomalyDetector(new OutboundAnomalyDetector.Configuration { MinimumBaselineWindows = 2 });
        Assert(lenient.Evaluate(Window(2, 500), [Window(0, 1, observationsWithBytes: 5), Window(1, 1)]) is null,
            "a baseline window without byte coverage is not counted towards having enough history");
        Assert(lenient.Evaluate(Window(2, 500, observationsWithBytes: 5), [Window(0, 1), Window(1, 1)]) is null,
            "a current window without byte coverage never raises an alert");

        // Sent and received answer different questions, and the overview
        // shows them apart. A single total mixes what left the machine with
        // everything that arrived and answers neither.
        var directionDatabase = Path.Combine(directory, "period-direction.db");
        using (var store = new ObservationStore(directionDatabase))
        {
            var now = DateTimeOffset.UtcNow;
            store.WriteBatch([
                new NetworkObservation(now.AddMinutes(-5), 11, "TCP", "10.0.0.7", 51_100, "203.0.113.50", 443,
                    3_000_000, 500_000, ObservationLayer.Logical, null, "etw", "uploader"),
                new NetworkObservation(now.AddMinutes(-4), 12, "TCP", "10.0.0.7", 51_101, "203.0.113.51", 443,
                    1_000_000, 9_000_000, ObservationLayer.Logical, null, "etw", "downloader"),
            ]);
            var period = store.ReadPeriodAnalysis(now.AddMinutes(-30), now.AddMinutes(1));
            Assert(period.BytesSent == 4_000_000 && period.BytesReceived == 9_500_000,
                "the period reports what left and what arrived as two numbers");
            Assert(period.Bytes == period.BytesSent + period.BytesReceived,
                "the existing total stays the sum of the two directions");
            Assert(!period.OutboundBaselineReady && period.OutboundAnomalies == 0,
                "a fresh database says it cannot judge yet rather than reporting no anomalies");
        }

        // The detector is only worth having if something calls it. A store
        // that captures windows, a caller that evaluates them and a row that
        // records the verdict are three separate things, and the last time
        // two of three were present the third went missing for weeks.
        var anomalyDatabase = Path.Combine(directory, "outbound-anomaly.db");
        using (var store = new ObservationStore(anomalyDatabase))
        {
            Assert(store.SchemaVersion == 17, "the traffic-window table arrives with schema 17");
            var now = DateTimeOffset.UtcNow;
            var window = new DateTimeOffset(now.UtcTicks - now.UtcTicks % TimeSpan.FromMinutes(15).Ticks, TimeSpan.Zero);
            var previous = window - TimeSpan.FromMinutes(15);
            store.WriteBatch(Enumerable.Range(0, 12).Select(index => new NetworkObservation(
                previous.AddMinutes(1), 500 + index, "TCP", "10.0.0.5", 50_000 + index,
                $"203.0.113.{index}", 443, 8 * 1024 * 1024, 0, ObservationLayer.Logical, null, "etw",
                $"sender{index}")).ToArray());

            var captured = store.CaptureOutboundTrafficWindow(now);
            Assert(captured is { } first && first.Current.StartedAt == previous &&
                first.Current.BytesOut == 12UL * 8 * 1024 * 1024 && first.Current.ObservationCount == 12 &&
                first.Current.ObservationsWithBytes == 12 && first.Current.ApplicationCount == 12 &&
                first.Current.DestinationCount == 12 && first.Current.LargestApplicationBytesOut == 8 * 1024 * 1024,
                "a captured window measures bytes, coverage, applications and the largest single sender");

            // Capturing twice would let a restart raise the same alert again.
            Assert(store.CaptureOutboundTrafficWindow(now) is null,
                "a window already captured is not captured a second time");

            Assert(store.ReadOutboundAnomalyCount(previous, now) == 0,
                "a captured window carries no verdict until one is recorded");
            store.RecordOutboundAnomaly(previous, OutboundAnomalyKind.DistributedTransfer);
            Assert(store.ReadOutboundAnomalyCount(previous, now) == 1 &&
                store.ReadOutboundAnomalyCount(previous.AddDays(-2), previous.AddDays(-1)) == 0,
                "a recorded anomaly is counted inside its period and not outside it");
        }

        // One overnight backup in the baseline must not become the new normal.
        var withSpike = new ulong[] { 10, 10, 11, 12, 900 }.Select((value, index) => Window(index, value)).ToArray();
        Assert(new OutboundAnomalyDetector(new OutboundAnomalyDetector.Configuration { MinimumBaselineWindows = 5 })
            .Evaluate(Window(5, 150), withSpike) is not null,
            "median and MAD keep one huge baseline window from hiding the next one");
    }

    {
        // The public-feed switch is a decision, so it is rejected unless the
        // request actually carries one.
        {
            bool? asked = null;
            var accepted = IpcProtocol.Handle("""{"v":1,"op":"set-public-threat-feeds","enabled":true}""", () => "{}", _ => [],
                setPublicThreatFeeds: enabled => { asked = enabled; return enabled; });
            Assert(asked == true && accepted.Contains("\"enabled\":true", StringComparison.Ordinal),
                "turning on public threat feeds reaches the service and reports what it did");
            Assert(IpcProtocol.Handle("""{"v":1,"op":"set-public-threat-feeds"}""", () => "{}", _ => [],
                setPublicThreatFeeds: enabled => enabled).Contains("invalid-threat-feed-setting", StringComparison.Ordinal),
                "a request without a choice in it is refused rather than guessed at");
        }

        // Health must judge what is being lost now, not what starting cost.
        //
        // On 0.1.58 the session lost 1,210,217 events in the gap between
        // enabling the providers and reading the buffers, then not one more
        // for the rest of the run -- and a rule that degrades on any loss at
        // all left the agent marked "needs attention" for hours, advising a
        // restart that would only repeat the loss.
        {
            var startup = new CollectorSnapshot("healthy", 100, 100, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0)
            { EtwEventsLost = 1_210_217, EtwEventsLostAtStart = 1_210_217 };
            Assert(AgentHealth.Evaluate(startup, "ok").Issues.Count == 0,
                "events lost while the trace session was starting do not make the agent unhealthy");

            var losing = startup with { EtwEventsLost = 1_210_300 };
            var issue = AgentHealth.Evaluate(losing, "ok").Issues.SingleOrDefault();
            Assert(issue is { Code: "etw-events-lost" } && !issue.Action.Contains("restart", StringComparison.OrdinalIgnoreCase),
                "events lost since then do, and the advice is not the restart that causes them");
        }

        // Public threat feeds, for agents with no Hub.
        //
        // The parsers are the Mac's and the Hub's. An Agent that disagrees
        // with its Hub about the same destination is the defect P3-19 exists
        // to prevent, and two platforms disagreeing is the same defect twice.
        {
            // CRLF on purpose. Three of the four feeds ship it, and on the Mac
            // splitting on a bare newline made the whole download one line that
            // started with a comment marker: zero indicators, no error, for
            // months.
            var feodo = "first_seen_utc,dst_ip,dst_port,c2_status,last_online,malware\r\n" +
                "2026-01-01,203.0.113.5,443,online,2026-01-02,Emotet\r\n";
            var parsedFeodo = ThreatFeedDownloader.Parse(feodo, "feodo", "feodo");
            Assert(parsedFeodo.Count == 1 && parsedFeodo[0].Value == "203.0.113.5" &&
                parsedFeodo[0].Kind == "ip" && parsedFeodo[0].Tag == "Emotet C2",
                "a CRLF feed is read line by line and names the malware from its own header");

            var threatFox = "first_seen_utc,ioc_id,ioc_value,ioc_type,threat_type,malware\r\n" +
                "2026-01-01,1,198.51.100.7:8080,ip:port,botnet_cc,Qakbot\r\n";
            var parsedFox = ThreatFeedDownloader.Parse(threatFox, "threatfox", "threatfox");
            Assert(parsedFox.Count == 1 && parsedFox[0].Value == "198.51.100.7" && parsedFox[0].Tag == "Qakbot",
                "the port is stripped, and the malware comes from the column that holds it");

            // The Mac counts commas instead, and for this exact shape takes
            // last_online as the malware family: its indicators read
            // "2026-01-02 C2". Its tests assert the address and the kind and
            // never the tag, so nothing noticed.
            var extraColumn = "first_seen_utc,dst_ip,dst_port,c2_status,last_online,malware,reference\r\n" +
                "2026-01-01,203.0.113.5,443,online,2026-01-02,TrickBot,https://example.test\r\n";
            Assert(ThreatFeedDownloader.Parse(extraColumn, "feodo", "feodo")[0].Tag == "TrickBot C2",
                "a feed that adds a column does not shift the malware name");

            var urlhaus = "# comment\r\n" +
                "1,2026-01-01,http://203.0.113.9/payload.exe,online,malware_download\r\n" +
                "2,2026-01-01,https://raw.githubusercontent.com/x/y/z.exe,online,malware_download\r\n";
            var parsedHaus = ThreatFeedDownloader.Parse(urlhaus, "urlhaus", "urlhaus");
            Assert(parsedHaus.Count == 2 &&
                parsedHaus[0] is { Kind: "ip", Confidence: "high" } &&
                parsedHaus[1] is { Kind: "domain", Value: "raw.githubusercontent.com", Confidence: "low" },
                "a file-hosting service is low confidence; an address serving malware is not");

            var spamhaus = "; comment\n1.2.3.0/24 ; SBL123456\n";
            var parsedDrop = ThreatFeedDownloader.Parse(spamhaus, "spamhausDrop", "spamhaus");
            Assert(parsedDrop.Count == 1 && parsedDrop[0].Kind == "cidr" && parsedDrop[0].Value == "1.2.3.0/24",
                "a hijacked network is kept as a range rather than a single address");

            Assert(ThreatFeedDownloader.ConfidenceForHost("gist.githubusercontent.com") == "low" &&
                ThreatFeedDownloader.ConfidenceForHost("x.amazonaws.com") == "low" &&
                ThreatFeedDownloader.ConfidenceForHost("evil.test") == "high",
                "confidence looks at the host and at its last two labels, as the Hub does");

            Assert(ThreatFeedDownloader.CsvFields("a,\"b,c\",d").SequenceEqual(["a", "b,c", "d"]),
                "a quoted field keeps its commas");

            // Feodo has published nothing since 2026-03-04. A feed that is
            // empty on purpose must not become a warning that never clears.
            Assert(ThreatFeedDownloader.PublishesEmptyLists.Contains("feodo") &&
                !ThreatFeedDownloader.PublishesEmptyLists.Contains("spamhaus"),
                "a feed that legitimately publishes nothing is not reported as missing");
        }

        // A diagnostics request must not re-read the database.
        //
        // It used to, under the lock every other request needs, on a pipe that
        // serves one caller at a time: measured on 0.1.57, a diagnostics call
        // took 30.7 seconds and every status request during it failed to even
        // connect, while a status call on its own takes 1 ms. The window polls
        // status every five seconds, so saving a bundle read as "status
        // unavailable" for half a minute.
        var reportDatabase = Path.Combine(directory, "diagnostics-speed.db");
        using (var store = new ObservationStore(reportDatabase))
        {
            var run = store.BeginRun(RunComponent.Service, "0.1.0");
            store.EndRun(run);
            Assert(store.VerifyIntegrityInBackground() == "ok", "a full read establishes what the file is");
            var snapshot = new CollectorSnapshot("healthy", 0, 0, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0);

            var live = DiagnosticsReport.Create(snapshot, store, "0.1.0", verifyIntegrity: false);
            Assert(live.Contains("\"integrity\": \"ok\"", StringComparison.Ordinal) &&
                live.Contains("integrityCheckedAt", StringComparison.Ordinal),
                "a report that did not re-read says what the last full read found, and when");

            // The offline bundle is the one place that may take its time:
            // it runs when the service will not start and nobody waits on it.
            Assert(DiagnosticsReport.Create(snapshot, store, "0.1.0", verifyIntegrity: true)
                .Contains("\"integrity\": \"ok\"", StringComparison.Ordinal),
                "the offline bundle still reads the database itself");
        }

        // The check at open happens only when the last run cannot vouch for
        // the file.
        //
        // Making it shallow was not enough: quick_check still reads every
        // page, and on a 7 GB database from a cold disk that measured 118,649
        // ms -- against 26,567 ms for the full check when the file was already
        // cached. The cost is the read, not the depth. So a run that said
        // goodbye is trusted at open and the full read happens afterwards,
        // off the path someone is waiting on.
        var depthDatabase = Path.Combine(directory, "integrity-depth.db");
        using (var store = new ObservationStore(depthDatabase))
        {
            Assert(!store.IntegrityCheckWasDeep && store.IntegrityCheckMilliseconds == 0,
                "creating a database does not check it");
            var run = store.BeginRun(RunComponent.Service, "0.1.0");
            store.EndRun(run);
        }
        using (var store = new ObservationStore(depthDatabase))
        {
            Assert(!store.IntegrityCheckWasDeep && store.IntegrityCheckMilliseconds == 0,
                "after a clean run the open reads nothing and starts immediately");
            Assert(store.BackgroundIntegrityCheckDue,
                "a full read that has never happened is owed, and said to be owed");
            Assert(store.VerifyIntegrityInBackground() == "ok",
                "the full read runs on its own connection and answers");
            // Reopening must not forget the answer: a bundle that says
            // "unverified" beside the time it was verified states two things
            // that cannot both be true.
            store.Dispose();
        }
        using (var store = new ObservationStore(depthDatabase))
        {
            Assert(store.LastVerifiedIntegrity == "ok" && store.LastDeepIntegrityCheckAt is not null,
                "an open that trusts the last run still reports what the last full read found");
            Assert(!store.BackgroundIntegrityCheckDue,
                "once the full read has happened it is no longer owed");
            store.BeginRun(RunComponent.Service, "0.1.0");
        }
        using (var store = new ObservationStore(depthDatabase))
        {
            // The previous line left a run open, so this start settles it as
            // unexpected -- the case worth waiting for.
            Assert(store.IntegrityCheckWasDeep,
                "after a run that did not say goodbye the open reads every page before trusting it");
        }

        // The shallow path must not be a blind path. A quick check still
        // reads page structure, and the risk-led policy is only worth having
        // if damage is still found when it takes the cheap route.
        var damagedDatabase = Path.Combine(directory, "integrity-damaged.db");
        using (var store = new ObservationStore(damagedDatabase))
        {
            store.WriteBatch(Enumerable.Range(0, 400).Select(index => new NetworkObservation(
                DateTimeOffset.UtcNow.AddSeconds(-index), 900 + index, "TCP", "10.0.0.9", 40_000 + index,
                $"198.51.100.{index % 250}", 443, 100, 100, ObservationLayer.Logical, null, "etw", "filler")).ToArray());
            var run = store.BeginRun(RunComponent.Service, "0.1.0");
            store.EndRun(run);
        }
        using (var store = new ObservationStore(damagedDatabase))
        {
            // Opened and abandoned, the way a killed service leaves it.
            store.BeginRun(RunComponent.Service, "0.1.0");
        }
        // Left deliberately unsettled, so the next open is the synchronous
        // full read rather than the trusting one.
        foreach (var suffix in new[] { "-wal", "-shm" }) File.Delete(damagedDatabase + suffix);
        var damaged = File.ReadAllBytes(damagedDatabase);
        // Well past the header, in the middle of the content.
        for (var offset = damaged.Length / 2; offset < damaged.Length / 2 + 512 && offset < damaged.Length; offset++)
            damaged[offset] ^= 0xFF;
        File.WriteAllBytes(damagedDatabase, damaged);
        AssertStoreOpenFails(() => new ObservationStore(damagedDatabase), StoreFailureKind.Corrupt,
            "damage is found before a database that cannot vouch for itself is used");

        // Turning destination-name reading off has to forget what was already
        // learned. On 2026-09-19 it did not, and two of the first forty-six
        // connections after the switch were still named from the cache -- the
        // request was to stop collecting names, not to stop reading them out.
        {
            var dns = new DnsNameCache();
            var at = DateTimeOffset.UtcNow;
            dns.Observe(4242, "example.test", "203.0.113.77", at);
            Assert(dns.Resolve(4242, "203.0.113.77", at) == "example.test",
                "a name observed for a process is used for that process's connections");
            dns.Forget();
            Assert(dns.Resolve(4242, "203.0.113.77", at) is null,
                "forgetting leaves nothing to name a later connection with");
        }

        // A window that was running when the service restarted is not running.
        // Only the window can close its own run, so a window that never comes
        // back used to leave the row marked running for ever -- and after a
        // reboot on 2026-09-19 it did exactly that, claiming a process killed
        // by the reboot had been alive since the previous evening.
        var strandedDatabase = Path.Combine(directory, "stranded-ui-run.db");
        using (var store = new ObservationStore(strandedDatabase))
        {
            store.BeginRun(RunComponent.Ui, "0.1.0");
            Assert(store.ReadRunHistory()[0].Ending == "running", "the window's run starts open");
            store.BeginRun(RunComponent.Service, "0.1.0");
            var rows = store.ReadRunHistory();
            Assert(rows.Single(run => run.Component == RunComponent.Ui).Ending == "unexpected",
                "a service start settles a window run left open by a restart");
            Assert(rows.Single(run => run.Component == RunComponent.Service).Ending == "running",
                "settling the window's run does not disturb the service's own");
        }

        // An OS shutdown and a crash both leave a run that never wrote its own
        // ending. Filing them under one word means the machine being restarted
        // outnumbers, and hides, the run that really did fail.
        var shutdownDatabase = Path.Combine(directory, "run-shutdown.db");
        using (var store = new ObservationStore(shutdownDatabase))
        {
            var stopped = store.BeginRun(RunComponent.Service, "0.1.0");
            store.EndSystemShutdownRun(stopped);
            Assert(store.ReadRunHistory()[0].Ending == "system-shutdown",
                "a run Windows warned about is recorded as a system shutdown, not as a crash");

            // The notification arrives before the tear-down, and the tear-down
            // may still finish. Finishing does not make it an ordinary stop:
            // the machine chose it, and that is what is worth counting.
            store.EndRun(stopped);
            Assert(store.ReadRunHistory()[0].Ending == "system-shutdown",
                "draining successfully on the way down does not overwrite why it was going down");

            // No notification, no inference. A killed process must keep
            // reading as killed, or the distinction buys nothing.
            store.BeginRun(RunComponent.Service, "0.1.0");
            store.BeginRun(RunComponent.Service, "0.1.0");
            Assert(store.ReadRunHistory()[1].Ending == "unexpected",
                "a run that was never notified stays unexpected rather than being guessed at");

            var report = DiagnosticsReport.Create(
                new CollectorSnapshot("healthy", 0, 0, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 0),
                store, "0.1.0");
            Assert(report.Contains("\"systemShutdown\": 1", StringComparison.Ordinal) &&
                report.Contains("\"unexpected\": 1", StringComparison.Ordinal),
                "the bundle counts the two kinds apart instead of reporting one total");
        }

        // The widened constraint has to survive the upgrade path, not just a
        // fresh database: an existing install is exactly where the old rows
        // and the new ending have to coexist.
        using (var reopened = new ObservationStore(shutdownDatabase))
        {
            Assert(reopened.SchemaVersion == 17 && reopened.ReadRunHistory().Count == 3,
                "reopening keeps every run recorded under the older vocabulary");
        }
    }

    {
        // The connection log can be read two ways, and they must not quietly
        // become the same reading. A conversation observed many times is one
        // row in `flows` spanning a period, and many rows in `observations`
        // each fixed to an instant. Collapsing the second into the first is
        // the mistake that made the timeline read as an accumulation.
        var logDatabase = Path.Combine(directory, "log-grain.db");
        var start = DateTimeOffset.UtcNow.AddMinutes(-30);
        using (var store = new ObservationStore(logDatabase))
        {
            await using var pipeline = new ObservationPipeline(store, capacity: 32, batchSize: 4);
            for (var index = 0; index < 6; index++)
                Assert(pipeline.TrySubmit(new NetworkObservation(
                    start.AddMinutes(index * 5), 77, "TCP", "100.64.0.9", 51_000,
                    "100.64.0.10", 443, 256, 128, ObservationLayer.Logical, "7", "etw", "LongLived", null)),
                    "observation of one long-running conversation accepted");
        }

        using var reading = new ObservationStore(logDatabase);
        var conversations = reading.ReadRecentFlows(50);
        var events = reading.ReadRecentObservations(50);

        Assert(conversations.Count == 1, "six observations of one conversation stay one row per conversation");
        Assert(conversations[0].FirstSeen < conversations[0].LastSeen,
            "a conversation spans time, so its two ends differ");
        Assert(events.Count == 6, "the same traffic is six rows when a row is one observation");
        Assert(events.All(row => row.FirstSeen == row.LastSeen),
            "an event happens at an instant, so both ends of its span are that instant");
        Assert(events[0].LastSeen > events[^1].LastSeen, "events are newest first");
        Assert(events.All(row => row.ProcessName == "LongLived" && row.RemotePort == 443),
            "the per-observation reading carries the same identity as the per-conversation one");
        Assert(events.Sum(row => row.BytesSent ?? 0) == 6 * 256 && conversations[0].BytesSent == 6 * 256,
            "both readings account for the same bytes even though the row counts differ");
        Assert(reading.ReadRecentObservations(50, 4).Count == 2,
            "the per-observation reading pages like the per-conversation one");
    }

    {
        // Streaming the log means reading events after a cursor and folding
        // them into conversations on the client. The fold must be the store's
        // fold: if the two rules differ, the same traffic is two different
        // pictures depending on which view is open.
        var streamDatabase = Path.Combine(directory, "log-stream.db");
        var start = DateTimeOffset.UtcNow.AddMinutes(-10);
        using var streaming = new ObservationStore(streamDatabase);

        var snapshot = streaming.ReadLogSnapshot(50, asEvents: false);
        Assert(snapshot.Cursor == 0 && snapshot.Rows.Count == 0, "an empty log starts at the beginning of the stream");

        await using (var pipeline = new ObservationPipeline(streaming, capacity: 64, batchSize: 4))
        {
            // Two peers over UDP from one local socket, which the store keeps
            // as a single conversation, plus a TCP pair it keeps apart.
            for (var index = 0; index < 4; index++)
                Assert(pipeline.TrySubmit(new NetworkObservation(
                    start.AddSeconds(index), 91, "UDP", "100.64.0.5", 5353,
                    index % 2 == 0 ? "100.64.0.6" : "100.64.0.7", 5353, 100, 50,
                    ObservationLayer.Logical, "3", "etw", "Responder", null)), "udp observation accepted");
            for (var index = 0; index < 3; index++)
                Assert(pipeline.TrySubmit(new NetworkObservation(
                    start.AddSeconds(index), 92, "TCP", "100.64.0.5", 40_000 + index,
                    "100.64.0.8", 443, 200, null, ObservationLayer.Logical, "3", "etw", "Client", null)),
                    "tcp observation accepted");
        }

        var delta = streaming.ReadObservationsSince(snapshot.Cursor, 100);
        Assert(delta.Rows.Count == 7 && !delta.More, "every event after the cursor arrives once");
        Assert(delta.Cursor > snapshot.Cursor, "the cursor advances past what was read");
        Assert(streaming.ReadObservationsSince(delta.Cursor, 100).Rows.Count == 0,
            "asking again after the cursor returns nothing rather than repeating");

        var folded = ObservationFold.Apply(snapshot.Rows, delta.Rows, 50);
        var stored = streaming.ReadRecentFlows(50);
        Assert(folded.Count == stored.Count,
            "folding the stream on the client yields the conversations the store recorded");
        Assert(stored.Count == 4, "one UDP socket is one conversation and three TCP ports are three");
        foreach (var row in folded)
        {
            var match = stored.Single(other =>
                StartupSnapshot.FlowKey(other.Protocol, other.LocalAddress, other.LocalPort, other.RemoteAddress, other.RemotePort, other.ProcessId) ==
                StartupSnapshot.FlowKey(row.Protocol, row.LocalAddress, row.LocalPort, row.RemoteAddress, row.RemotePort, row.ProcessId));
            Assert(match.BytesSent == row.BytesSent && match.BytesReceived == row.BytesReceived,
                "the client fold accounts for the same bytes as the store");
            Assert(match.FirstSeen == row.FirstSeen && match.LastSeen == row.LastSeen,
                "the client fold spans the same period as the store");
        }

        // A burst larger than one page must announce itself, not silently
        // present a fraction as the whole.
        var partial = streaming.ReadObservationsSince(snapshot.Cursor, 3);
        Assert(partial.Rows.Count == 3 && partial.More, "a full page says there is more behind it");
        Assert(streaming.ReadObservationsSince(partial.Cursor, 100).Rows.Count == 4,
            "resuming from a partial page continues where it stopped");

        // A conversation never measured must not be reported as measuring zero.
        var unmeasured = new RecentFlow(start, start, "UDP", "100.64.0.5", 9_999, "100.64.0.6", 53, 5, "App",
            null, null, ObservationLayer.Logical, null, "etw");
        Assert(ObservationFold.Apply([unmeasured], [unmeasured], 50)[0].BytesSent is null,
            "folding two unmeasured sightings leaves the volume unknown rather than zero");
    }

{
    // A caller that blocks on an IPC request must not deadlock.
    //
    // The window does exactly that on the way out, and it did it on the way in
    // too. If the request resumes on the caller's context, the continuation
    // waits for a thread that is waiting for the continuation -- and the
    // timeout cannot fire either, because firing it needs the same thread. The
    // whole application then never opens, which is what a user saw: an agent
    // installed, running, and invisible.
    //
    // The context here accepts work and never runs it, which is what a blocked
    // dispatcher amounts to.
    var blocked = new RefusingSynchronizationContext();
    var previous = SynchronizationContext.Current;
    SynchronizationContext.SetSynchronizationContext(blocked);
    try
    {
        var completed = Task.Run(() =>
        {
            SynchronizationContext.SetSynchronizationContext(blocked);
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
                AgentIpcClient.RequestAsync("{}", timeout.Token).GetAwaiter().GetResult();
            }
            // No agent is listening in this test, so failing is expected.
            // Returning at all is the thing being asserted.
            catch (Exception) { }
        }).Wait(TimeSpan.FromSeconds(20));
        Assert(completed, "an IPC request does not deadlock a caller that blocks on it");
        Assert(blocked.Posted == 0, "an IPC request resumes on the thread pool, not on its caller's context");
    }
    finally { SynchronizationContext.SetSynchronizationContext(previous); }
}

{
    // A stop that cannot drain in time must not be thrown out of the tear-down.
    //
    // It was. The body had already recorded the run as clean, the drain then
    // timed out, the exception left the service, and Windows filed the stop as
    // an unexpected termination -- so the agent's own record and the operating
    // system's said opposite things about the same stop. What is worth keeping
    // is not the exception but the count: those observations are lost either
    // way, and only the number says how many.
    var drainDatabase = Path.Combine(directory, "drain.db");
    using (var drainStore = new ObservationStore(drainDatabase))
    {
        var pipeline = new ObservationPipeline(drainStore, capacity: 8, batchSize: 4);
        Assert(pipeline.TrySubmit(new NetworkObservation(
            DateTimeOffset.UtcNow, 5, "TCP", "100.64.0.1", 2000, "100.64.0.2", 443, 16, 16,
            ObservationLayer.Logical, "1", "etw", "Drain", null)), "observation accepted before the stop");
        await pipeline.DisposeAsync();
        Assert(ObservationPipeline.DrainLimit > TimeSpan.Zero, "the drain limit is a named value, not a literal");
    }

    using (var reopened = new ObservationStore(drainDatabase))
    {
        var counters = reopened.ReadCounters();
        long Counter(string name) => counters.TryGetValue(name, out var value) ? value : 0;
        // Nothing was abandoned here, so nothing should claim it was: the
        // counter exists to be believed when it is not zero.
        Assert(Counter("shutdown-drain-timeout") == 0,
            "a stop that drained does not report that it could not");
        Assert(Counter("shutdown-abandoned-observations") == 0,
            "a stop that drained abandons nothing");
    }
}

Console.WriteLine("PASS: persistence, migration backup, corruption/disk-full gates, snapshot upsert, coverage, bounded drops, and privacy-safe diagnostics, process-name retention, rejection reasons, globe geometry, run history, connection-log grain, log streaming, IPC context independence, shutdown drain reporting, system-shutdown endings, window run reports, outbound anomalies, portable settings, directional period totals, risk-led integrity checks, public threat feeds, and startup event loss");
    return 0;
}
finally
{
    Directory.Delete(directory, recursive: true);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException($"FAILED: {message}");
}

static void AssertStoreFailure(Action action, StoreFailureKind expected, string message)
{
    try { action(); }
    catch (ObservationStoreException exception) when (exception.Kind == expected) { return; }
    throw new InvalidOperationException($"FAILED: {message}");
}

/// The same, for a call that returns a store when it should have thrown.
///
/// Leaving that store open made the run die later, in the temp-directory
/// cleanup, with a file-in-use error naming neither the assertion nor the
/// reason -- so a real regression would have been reported as a tidying
/// problem.
static void AssertStoreOpenFails(Func<ObservationStore> open, StoreFailureKind expected, string message)
{
    ObservationStore? opened = null;
    try { opened = open(); }
    catch (ObservationStoreException exception) when (exception.Kind == expected) { return; }
    finally { opened?.Dispose(); }
    throw new InvalidOperationException($"FAILED: {message}");
}

static async Task AssertEnrollmentFailure(Func<Task> action, string reason, string message)
{
    try { await action(); }
    catch (AgentEnrollmentException exception) when (exception.Reason == reason) { return; }
    throw new InvalidOperationException($"FAILED: {message}");
}

sealed class EnrollmentHandler(params (HttpStatusCode Status, string Body)[] responses) : HttpMessageHandler
{
    private readonly Queue<(HttpStatusCode Status, string Body)> responses = new(responses);
    public List<HttpRequestMessage> Requests { get; } = [];
    public bool SawAuthorization { get; private set; }
    public bool SawUserAgent { get; private set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        SawAuthorization |= request.Headers.Authorization is not null;
        SawUserAgent |= request.Headers.UserAgent.Any(value => value.Product?.Name == "EgressView-Agent-Windows");
        Requests.Add(new HttpRequestMessage(request.Method, request.RequestUri) { Content = new StringContent(await request.Content!.ReadAsStringAsync(cancellationToken)) });
        var response = responses.Dequeue();
        return new HttpResponseMessage(response.Status) { Content = new StringContent(response.Body, Encoding.UTF8, "application/json") };
    }
}

sealed class UninstallHandler(HttpStatusCode status) : HttpMessageHandler
{
    public Uri? RequestUri { get; private set; }
    public bool SawBearer { get; private set; }
    public long ContentBytes { get; private set; } = -1;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        RequestUri = request.RequestUri;
        SawBearer = request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter?.StartsWith("egva_", StringComparison.Ordinal) == true;
        ContentBytes = request.Content is null ? 0 : (await request.Content.ReadAsByteArrayAsync(cancellationToken)).LongLength;
        return new HttpResponseMessage(status) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
    }
}

sealed class AcceptManifestVerifier : IAgentManifestVerifier
{
    public bool Verify(ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature) => signature.SequenceEqual(new byte[] { 1, 2, 3 });
}

sealed class TestPackageVerifier : IWindowsPackageVerifier
{
    public int Calls { get; private set; }
    public string Verify(string path, string expectedPublisher)
    {
        Calls++;
        if (!expectedPublisher.StartsWith("EgressView", StringComparison.Ordinal) || !File.Exists(path)) throw new InvalidOperationException("unexpected verifier input");
        return "EgressView Code Signing";
    }
}

sealed class UpdateHandler(string manifest, byte[] package) : HttpMessageHandler
{
    public List<string> UserAgents { get; } = [];
    public bool SawCookie { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        UserAgents.Add(request.Headers.UserAgent.ToString());
        SawCookie |= request.Headers.Contains("Cookie");
        var path = request.RequestUri!.AbsolutePath;
        HttpContent content = path.EndsWith("manifest.json", StringComparison.Ordinal)
            ? new StringContent(manifest, Encoding.UTF8, "application/json")
            : path.EndsWith("manifest.json.sig", StringComparison.Ordinal)
                ? new ByteArrayContent([1, 2, 3])
                : new ByteArrayContent(package);
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = content });
    }
}

sealed class AiHandler(string responseBody) : HttpMessageHandler
{
    public bool SawBearer { get; private set; }
    public string Body { get; private set; } = "";
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        SawBearer = request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter == "secret-key";
        Body = request.Content is null ? "" : await request.Content.ReadAsStringAsync(cancellationToken);
        return new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(responseBody, Encoding.UTF8, "application/json") };
    }
}

sealed class DeliveryHandler(params int[] statuses) : HttpMessageHandler
{
    private readonly Queue<int> statuses = new(statuses);
    public List<Guid> BatchIds { get; } = [];
    public List<int> ObservationCounts { get; } = [];
    public bool SawEtwCollector { get; private set; }
    public bool SawProcessId { get; private set; }
    public bool SawBearer { get; private set; }
    public bool SawUserAgent { get; private set; }
    public bool SawRemoteHostname { get; private set; }
    public int CapabilityRequests { get; private set; }
    public int IngestRequests { get; private set; }
    public string? LastIngestBody { get; private set; }
    public HttpStatusCode CapabilitiesStatus { get; set; } = HttpStatusCode.NotFound;
    public string CapabilitiesJson { get; set; } = "{}";
    public int RejectedAcknowledgements { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        SawBearer |= request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter?.StartsWith("egva_", StringComparison.Ordinal) == true;
        SawUserAgent |= request.Headers.UserAgent.Any(value => value.Product?.Name == "EgressView-Agent-Windows");
        if (request.Method == HttpMethod.Get)
        {
            CapabilityRequests++;
            return new HttpResponseMessage(CapabilitiesStatus)
            {
                Content = new StringContent(CapabilitiesJson, Encoding.UTF8, "application/json"),
            };
        }
        IngestRequests++;
        var body = await request.Content!.ReadAsStringAsync(cancellationToken);
        LastIngestBody = body;
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        var batchId = root.GetProperty("batchId").GetGuid();
        BatchIds.Add(batchId);
        var observations = root.GetProperty("observations");
        ObservationCounts.Add(observations.GetArrayLength());
        var observation = observations[0];
        SawEtwCollector |= observation.GetProperty("collector").GetString() == "etw";
        SawProcessId |= observation.GetProperty("processID").GetInt32() == 88;
        SawRemoteHostname |= observation.TryGetProperty("remoteHostname", out var hostname) && hostname.GetString()?.EndsWith(".example", StringComparison.Ordinal) == true;
        var status = statuses.Dequeue();
        var response = new HttpResponseMessage((HttpStatusCode)status);
        if (status == 429) response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
        var rejected = status == 200 && RejectedAcknowledgements > 0 ? 1 : 0;
        if (rejected > 0) RejectedAcknowledgements -= 1;
        response.Content = new StringContent(status == 200
            ? $"{{\"batchId\":\"{batchId}\",\"accepted\":{observations.GetArrayLength() - rejected},\"duplicate\":0,\"rejected\":{rejected},\"replayed\":false}}"
            : "{}", Encoding.UTF8, "application/json");
        return response;
    }
}

sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
{
    public DateTimeOffset UtcNow { get; private set; } = utcNow;
    public override DateTimeOffset GetUtcNow() => UtcNow;
    public void Advance(TimeSpan value) => UtcNow += value;
}


/// A context that accepts work and never runs it, the way a dispatcher waiting
/// on a blocking call does.
internal sealed class RefusingSynchronizationContext : SynchronizationContext
{
    private int posted;
    public int Posted => Volatile.Read(ref posted);
    public override void Post(SendOrPostCallback d, object? state) => Interlocked.Increment(ref posted);
    public override void Send(SendOrPostCallback d, object? state) => Interlocked.Increment(ref posted);
}
