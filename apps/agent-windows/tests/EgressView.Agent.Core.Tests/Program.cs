using System.Net;
using System.Text;
using System.Text.Json;
using EgressView.Agent.Core;

var directory = Path.Combine(Path.GetTempPath(), $"egressview-agent-tests-{Guid.NewGuid():N}");
Directory.CreateDirectory(directory);
var database = Path.Combine(directory, "agent.db");

try
{
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
                .SetEquals(new[] { "README.txt", "diagnostics.json" }),
            "diagnostics bundle contains only documented privacy-safe files");
        using var bundleReader = new StreamReader(archive.GetEntry("diagnostics.json")!.Open());
        Assert(!bundleReader.ReadToEnd().Contains("100.64.0.1", StringComparison.Ordinal), "bundle excludes endpoint");

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
    bool? monitoringEnabled = null;
    var monitoringResponse = IpcProtocol.Handle("""{"v":1,"op":"set-monitoring-enabled","enabled":false}""", () => "{}", _ => [],
        setMonitoringEnabled: enabled => { monitoringEnabled = enabled; return enabled; });
    Assert(monitoringEnabled == false && monitoringResponse.Contains("\"enabled\":false", StringComparison.Ordinal),
        "authenticated IPC changes the monitoring state without stopping the service");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"set-monitoring-enabled","enabled":"no"}""", () => "{}", _ => [],
        setMonitoringEnabled: enabled => enabled).Contains("invalid-monitoring-setting", StringComparison.Ordinal),
        "IPC rejects a non-boolean monitoring state");
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
    var globeResponse = IpcProtocol.Handle("""{"v":1,"op":"globe","days":7}""", () => "{}", _ => [],
        globePoints: _ => [new GlobePoint(35.68, 139.76, "JP", "Tokyo", 4, 1024)]);
    Assert(globeResponse.Contains("Tokyo", StringComparison.Ordinal), "IPC returns bounded globe aggregates to the authenticated UI");
    var analysisResponse = IpcProtocol.Handle("""{"v":1,"op":"analysis","minutes":360}""", () => "{}", _ => [],
        analysis: (minutes, offset) => new PeriodAnalysis(DateTimeOffset.UtcNow.AddMinutes(-minutes-offset), DateTimeOffset.UtcNow.AddMinutes(-offset),
            12, 2, 3, 4096, 1, 1, DateTimeOffset.UtcNow.AddDays(-1), 20, [], []));
    Assert(analysisResponse.Contains("\"Connections\":12", StringComparison.Ordinal), "IPC returns bounded period analysis");
    Assert(IpcProtocol.Handle("""{"v":1,"op":"analysis","minutes":61}""", () => "{}", _ => [], analysis: (_, _) => throw new InvalidOperationException()).Contains("invalid-range", StringComparison.Ordinal),
        "IPC rejects an arbitrary analysis range");
    var csv = ObservationCsv.Export([new RecentFlow(DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch, "TCP", "::1", 50000,
        "203.0.113.8", 443, 42, "Browser, \"Beta\"", null, 20, ObservationLayer.Logical, null, "etw")]);
    Assert(csv.Contains("\"Browser, \"\"Beta\"\"\"", StringComparison.Ordinal) && csv.Contains("remote_hostname", StringComparison.Ordinal) && csv.EndsWith("\r\n", StringComparison.Ordinal),
        "CSV includes hostname, follows RFC 4180 quoting and ends with a record separator");
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
        var resumed = coverageStore.BeginCoverage(snapshot, started.AddSeconds(20));
        coverageStore.EndCoverage(resumed, started.AddSeconds(22));
        var suspendWindow = coverageStore.ReadPeriodAnalysis(started.AddSeconds(10), started.AddSeconds(22));
        Assert(Math.Abs(suspendWindow.CoverageRatio - (4d / 12d)) < 0.001,
            "a heartbeat or ETW-loss interruption leaves the unconfirmed gap outside monitoring coverage");
    }

    var liveSnapshot = StartupSnapshot.Capture();
    Assert(liveSnapshot.Where(flow => flow.Protocol == "TCP").All(flow => flow.RemotePort > 0),
        "TCP startup snapshot excludes listeners");

    var legacyDatabase = Path.Combine(directory, "legacy-v1.db");
    ObservationStore.CreateVersion1FixtureForTesting(legacyDatabase);
    using (var migrated = new ObservationStore(legacyDatabase))
    {
        Assert(migrated.SchemaVersion == 11, "v1 database migrates through v2-v11");
        Assert(!migrated.DeliveryEnabled, "delivery is opt-in after migration");
        Assert(migrated.Inspect().Integrity == "ok", "migrated database integrity is ok");
    }
    var migrationBackups = Directory.GetFiles(directory, "legacy-v1.db.pre-v*.bak");
    Assert(migrationBackups.Length == 1 && migrationBackups.Single().EndsWith("pre-v11.bak", StringComparison.Ordinal),
        "migration retains only the newest consistent backup generation");
    using (var migratedAgain = new ObservationStore(legacyDatabase))
        Assert(migratedAgain.SchemaVersion == 11, "migration is idempotent on restart");

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
        var result = retentionStore.PruneRetentionBatch(now, batchSize: 1);
        Assert(result.ObservationsDeleted == 1 && result.FlowsDeleted == 1 && result.HourlySummariesDeleted == 1 && result.CoverageSessionsDeleted == 1 && result.ChartSummariesDeleted == 1,
            "retention prunes raw data at 14 days and aggregates at 30 days in bounded batches");
        var second = retentionStore.PruneRetentionBatch(now, batchSize: 10);
        Assert(second.ObservationsDeleted == 1 && second.FlowsDeleted == 0,
            "raw observations older than 14 days are removed without deleting 30-day flows");
        Assert(retentionStore.Inspect().Count == 1 && retentionStore.ReadRecentFlows(50).Count == 2,
            "fresh raw data and 30-day aggregate data survive retention");
        retentionStore.WriteBatch([
            new NetworkObservation(now.AddDays(-31), 4, "TCP", "10.0.0.1", 40004, "203.0.113.4", 443, 1, 1, ObservationLayer.Logical, null, "etw", "Queued")
        ], queueForDelivery: true);
        var pending = retentionStore.ReadDeliveryStatus().Pending;
        while (retentionStore.PruneRetentionBatch(now, batchSize: 10).TotalDeleted > 0) { }
        Assert(pending == 1 && retentionStore.ReadDeliveryStatus().Pending == 1,
            "retention never deletes unsent delivery queue data");
    }


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
        Assert(geoStore.ReadGeoCacheState() is { ETag: "etag-1", LocationCount: 1 }, "geo cache state reports its version and exact location count");
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
            threatReport.Findings.Single().MatchedValue == "bad.example",
            "parent-domain indicators match locally while hostname-unavailable destinations remain explicit");
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

    Console.WriteLine("PASS: persistence, migration backup, corruption/disk-full gates, snapshot upsert, coverage, bounded drops, and privacy-safe diagnostics, process-name retention, rejection reasons, and globe geometry");
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

sealed class DeliveryHandler(params int[] statuses) : HttpMessageHandler
{
    private readonly Queue<int> statuses = new(statuses);
    public List<Guid> BatchIds { get; } = [];
    public bool SawEtwCollector { get; private set; }
    public bool SawProcessId { get; private set; }
    public bool SawBearer { get; private set; }
    public bool SawUserAgent { get; private set; }
    public int RejectedAcknowledgements { get; set; }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var body = await request.Content!.ReadAsStringAsync(cancellationToken);
        using var document = JsonDocument.Parse(body);
        var root = document.RootElement;
        var batchId = root.GetProperty("batchId").GetGuid();
        BatchIds.Add(batchId);
        var observation = root.GetProperty("observations")[0];
        SawEtwCollector |= observation.GetProperty("collector").GetString() == "etw";
        SawProcessId |= observation.GetProperty("processID").GetInt32() == 88;
        SawBearer |= request.Headers.Authorization?.Scheme == "Bearer" && request.Headers.Authorization.Parameter?.StartsWith("egva_", StringComparison.Ordinal) == true;
        SawUserAgent |= request.Headers.UserAgent.Any(value => value.Product?.Name == "EgressView-Agent-Windows");
        var status = statuses.Dequeue();
        var response = new HttpResponseMessage((HttpStatusCode)status);
        if (status == 429) response.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(7));
        var rejected = status == 200 && RejectedAcknowledgements > 0 ? 1 : 0;
        if (rejected > 0) RejectedAcknowledgements -= 1;
        response.Content = new StringContent(status == 200
            ? $"{{\"batchId\":\"{batchId}\",\"accepted\":{1 - rejected},\"duplicate\":0,\"rejected\":{rejected},\"replayed\":false}}"
            : "{}", Encoding.UTF8, "application/json");
        return response;
    }
}
