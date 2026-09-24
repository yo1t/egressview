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
// The icons still match the artwork they were drawn from.
//
// design/icons holds the mark both agents build from; the .ico files beside
// the Windows UI are generated from it by tools/make-icons and committed,
// because the build needs them and CI cannot run a macOS render script.
// Committed output drifts the moment the source is edited and nobody
// remembers, so the colours are tied back here: change the SVG and this fails
// until the icons are regenerated.
{
    var iconRoot = Path.Combine(windowsRoot, "src", "EgressView.Agent.Ui", "Assets");
    var markSvg = File.ReadAllText(Path.Combine(windowsRoot, "..", "..", "design", "icons", "egressview-mark.svg"));
    foreach (var colour in new[] { "#0b1424", "#4d94ff", "#24d6a2" })
        Assert(markSvg.Contains(colour, StringComparison.OrdinalIgnoreCase),
            $"the mark still uses {colour}; if the artwork moved on, regenerate the icons with tools/make-icons");

    string[] expected = ["egressview", "tray-monitoring", "tray-stopped", "tray-attention", "tray-unavailable"];
    foreach (var name in expected)
    {
        var path = Path.Combine(iconRoot, name + ".ico");
        Assert(File.Exists(path), $"{name}.ico is present, because the window and the tray load it by name");
        var bytes = File.ReadAllBytes(path);
        Assert(bytes.Length > 1000 && bytes[0] == 0 && bytes[1] == 0 && bytes[2] == 1 && bytes[3] == 0,
            $"{name}.ico is an icon container rather than whatever else ended up at that path");
        var frames = bytes[4] | (bytes[5] << 8);
        Assert(frames >= 7, $"{name}.ico carries every size it is asked for, rather than one that gets scaled");

        // Sizes are declared in the directory, one entry every sixteen bytes.
        var sizes = Enumerable.Range(0, frames).Select(index => (int)bytes[6 + index * 16]).ToArray();
        Assert(sizes.Contains(16) && sizes.Contains(32),
            $"{name}.ico has the sizes the tray and the title bar actually draw");
        // 256 is written as 0, which is the format's way of saying it.
        if (name == "egressview")
            Assert(sizes.Contains(0), "the app icon has the 256 size Explorer shows at its largest");
    }

    // The tray states are told apart by shape, as on the Mac, so they cannot
    // all be the same drawing.
    var monitoring = File.ReadAllBytes(Path.Combine(iconRoot, "tray-monitoring.ico"));
    var stopped = File.ReadAllBytes(Path.Combine(iconRoot, "tray-stopped.ico"));
    var attention = File.ReadAllBytes(Path.Combine(iconRoot, "tray-attention.ico"));
    Assert(!monitoring.SequenceEqual(stopped) && !stopped.SequenceEqual(attention) && !monitoring.SequenceEqual(attention),
        "the three tray states are three different icons, not one icon under three names");
}

// Every string that takes a value in one language takes it in the other.
//
// A sed that was meant for one string replaced "{0}" with the word PLACEHOLDER
// in four Japanese ones. Nothing failed: the text still rendered, and the
// window simply showed "最終確認 PLACEHOLDER" where a timestamp belonged. It
// shipped, because no test compared the two files for the slots they carry.
foreach (var entry in windowsEnglish.Descendants().Where(element => element.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml")) is not null))
{
    var key = entry.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml"))!.Value;
    var japanese = windowsJapanese.Descendants()
        .SingleOrDefault(element => element.Attribute(XName.Get("Key", "http://schemas.microsoft.com/winfx/2006/xaml"))?.Value == key);
    if (japanese is null) continue;
    static SortedSet<string> Slots(string text) =>
        new(Regex.Matches(text, @"\{\d+[^}]*\}").Select(match => match.Value), StringComparer.Ordinal);
    var english = Slots(entry.Value);
    Assert(english.SetEquals(Slots(japanese.Value)),
        $"the value slots differ between languages: {key}");
    Assert(!japanese.Value.Contains("PLACEHOLDER", StringComparison.Ordinal),
        $"a placeholder word was left in the Japanese wording: {key}");
}

// The privacy note is composed, not fixed, so its placeholder has to survive
// translation. A missing {0} would not fail to build or throw: it would print
// a sentence that quietly omits which services this PC contacts, which is the
// one fact the line exists to carry.
foreach (var document in new[] { windowsEnglish, windowsJapanese })
{
    Assert(SharedResource(document, "EnrichmentPrivacyDirect").Contains("{0}", StringComparison.Ordinal),
        "the direct-source privacy note keeps the slot the source names go in");
    foreach (var key in new[] { "SourcePublicFeeds", "SourceMaxMind", "EnrichmentPrivacy" })
        Assert(SharedResource(document, key).Trim().Length > 0, $"the privacy note has wording for {key}");
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

    // More than one caller at a time (P3-140). The 30-day analysis takes 8.8 s
    // on a real machine, and a status request made during it could not even
    // connect: the server served one caller and had no pipe open meanwhile.
    //
    // The count alone was not the fix. A second instance of a pipe can only be
    // created by someone the first instance's rules allow to, and those rules
    // did not name the service's own account. Measured: a second instance was
    // refused with UnauthorizedAccessException.
    {
        // One would make everything below pass while serving one caller.
        Assert(EgressView.Agent.Service.AgentIpcServer.Listeners >= 2,
            $"more than one caller at a time, not {EgressView.Agent.Service.AgentIpcServer.Listeners}");
        var pipeName = "egressview-agent-test-" + Guid.NewGuid().ToString("N")[..8];
        // The window's user and the server are different identities in
        // production -- a signed-in user and NT SERVICE\EgressViewAgent -- and
        // this test has to keep them apart. 0.1.125's version used this
        // process's SID for both, so the window's read/write grant covered the
        // server too: the test passed while the installed service failed every
        // listener after the first, thirty times a second. The next attempt
        // put the window on BUILTIN\Users, which this process is a member of,
        // and passed for the same reason. The window here is LocalService,
        // which this process is certainly not, so only the server's own rule
        // can let it add instances. This process stands in for the service.
        var mine = new System.Security.Principal.SecurityIdentifier(
            System.Security.Principal.WellKnownSidType.LocalServiceSid, null).Value;
        var serverSid = System.Security.Principal.WindowsIdentity.GetCurrent().User!;
        var servers = new List<System.IO.Pipes.NamedPipeServerStream>();
        Exception? refused = null;
        try
        {
            for (var i = 0; i < EgressView.Agent.Service.AgentIpcServer.Listeners; i++)
                servers.Add(System.IO.Pipes.NamedPipeServerStreamAcl.Create(pipeName, System.IO.Pipes.PipeDirection.InOut,
                    EgressView.Agent.Service.AgentIpcServer.Listeners, System.IO.Pipes.PipeTransmissionMode.Byte,
                    System.IO.Pipes.PipeOptions.Asynchronous, 4096, 4096,
                    EgressView.Agent.Service.AgentIpcServer.BuildSecurity(mine, serverSid)));
        }
        catch (Exception exception) { refused = exception; }
        Assert(refused is null && servers.Count == EgressView.Agent.Service.AgentIpcServer.Listeners,
            $"every listener's instance can be created under the server's own rules, not {servers.Count} ({refused?.GetType().Name})");

        // And every one of them takes a caller at the same time: one busy
        // request no longer leaves the next with nothing to connect to.
        var accepted = servers.Select(server => server.WaitForConnectionAsync()).ToArray();
        var clients = servers.Select(_ => new System.IO.Pipes.NamedPipeClientStream(".", pipeName, System.IO.Pipes.PipeDirection.InOut,
            System.IO.Pipes.PipeOptions.Asynchronous)).ToList();
        foreach (var client in clients) await client.ConnectAsync(2_000);
        Assert(Task.WaitAll(accepted, 2_000), "all of them are connected at once");
        foreach (var client in clients) client.Dispose();
        foreach (var server in servers) server.Dispose();
    }

    // The service's own SID, computed from its name, is the one Windows gives
    // it: checked against `sc showsid EgressViewAgent` on the machine this was
    // written on. And this test process is not the service.
    {
        var computed = EgressView.Agent.Service.ServiceIdentity.Sid().Value;
        Assert(computed == "S-1-5-80-3647343375-3317903249-2886918786-2439003730-1861424852",
            $"the service SID is the one Windows derives, not {computed}");
        Assert(!EgressView.Agent.Service.ServiceIdentity.CarriesOwnSid(EgressView.Agent.Service.ServiceIdentity.Sid()),
            "a process that is not the service does not carry its SID, and would run one listener");
    }

    // A listener that keeps failing backs off, up to half a minute. 0.1.125's
    // failed ten times a second each, for as long as the service ran.
    {
        var firstDelay = TimeSpan.FromMilliseconds(100);
        Assert(EgressView.Agent.Service.AgentIpcServer.RetryDelay(firstDelay, 1) == firstDelay,
            "one failure is retried at the usual pace");
        Assert(EgressView.Agent.Service.AgentIpcServer.RetryDelay(firstDelay, 2) == TimeSpan.FromMilliseconds(200)
               && EgressView.Agent.Service.AgentIpcServer.RetryDelay(firstDelay, 4) == TimeSpan.FromMilliseconds(800),
            "and each further one waits twice as long");
        Assert(EgressView.Agent.Service.AgentIpcServer.RetryDelay(firstDelay, 50) == TimeSpan.FromSeconds(30),
            "up to half a minute, however many there are");
    }

    // A status request does not wait behind a long one, and does not lie for
    // long either.
    {
        var clock = DateTimeOffset.UtcNow;
        var statusFallback = new EgressView.Agent.Service.StatusFallback(TimeSpan.FromMilliseconds(100), TimeSpan.FromSeconds(60), () => clock);
        var first = statusFallback.Get(() => """{"monitoring":"running"}""");
        Assert(first == """{"monitoring":"running"}""", "a status that is ready in time is the status");

        // The store is busy: the build is still waiting for its lock.
        // Released by a timer, not after the call returns: an implementation
        // that always waited would otherwise wait for ever, and a hung test
        // is a worse way to find out than a failed one.
        var release = new ManualResetEventSlim();
        _ = Task.Delay(1_500).ContinueWith(_ => release.Set());
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var busy = statusFallback.Get(() => { release.Wait(); return """{"monitoring":"new"}"""; });
        watch.Stop();
        Assert(watch.ElapsedMilliseconds < 1_000, $"it does not wait for the lock, not {watch.ElapsedMilliseconds} ms");
        using (var busyDocument = JsonDocument.Parse(busy))
        {
            var busyRoot = busyDocument.RootElement;
            Assert(busyRoot.GetProperty("monitoring").GetString() == "running"
                   && busyRoot.GetProperty("servedWhileBusy").GetBoolean()
                   && busyRoot.GetProperty("statusAt").GetDateTimeOffset() == clock,
                $"it answers with the last status, saying so and saying when: {busy}");
        }
        release.Set();

        // Once the last one is too old, it waits for the real answer rather
        // than keep saying "monitoring" about a service that may be stuck.
        clock = clock.AddSeconds(61);
        var stale = new ManualResetEventSlim();
        var waited = Task.Run(() => statusFallback.Get(() => { stale.Wait(); return """{"monitoring":"real"}"""; }));
        Assert(!waited.Wait(400), "with nothing recent enough to stand in, it waits");
        stale.Set();
        Assert(waited.Wait(2_000) && waited.Result == """{"monitoring":"real"}""",
            "and answers with the real status when it comes");

        // And a status that fails, fails: the cache does not hide an error.
        Exception? failure = null;
        try { statusFallback.Get(() => throw new InvalidOperationException("store failed")); }
        catch (Exception exception) { failure = exception; }
        Assert(failure is InvalidOperationException, $"a failing status still fails, not {failure?.GetType().Name}");
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

    // A release nobody signed: the Agent says where to get it rather than
    // installing it. Until the packages carry an Authenticode signature this
    // is the only honest answer -- anyone able to answer for the update origin
    // could otherwise hand this machine an installer to run as administrator.
    {
        var manifestWithoutPackages = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            platform = "windows",
            version = "9.8.7",
            releasedAt = DateTimeOffset.UtcNow,
            packages = Array.Empty<object>(),
        });
        var verifier = new TestPackageVerifier();
        using var client = new WindowsAgentUpdateClient(new UpdateHandler(manifestWithoutPackages, []),
            verifier: verifier, manifestVerifier: new AcceptManifestVerifier());
        var decision = await client.CheckAsync("1.0.0", "10.0.26100");
        Assert(decision.Kind == AgentUpdateDecisionKind.DownloadManually && decision.PublishedVersion == "9.8.7",
            "a release with nothing to install still reports the version that exists");
        Assert(decision.Candidate is null && verifier.Calls == 0,
            "nothing is downloaded and nothing is verified, because there is nothing being offered");
        Assert(client.DownloadPage.Scheme == "https" && client.DownloadPage.Host == "dl.egressview.com",
            "the page offered is the origin the manifest came from, over HTTPS");
        // The host was all this checked, and the host was never the problem.
        // It pointed at "windows/", which is the bucket prefix the .msi files
        // sit under, not a page: a browser sent there got AccessDenied from
        // S3. A gate that reads the host and not the path cannot tell the
        // right page from the wrong one on the same site.
        Assert(client.DownloadPage.AbsolutePath == "/",
            "the download page is the site root, not a directory of packages");
        Assert(!client.DownloadPage.AbsoluteUri.Contains("/windows/", StringComparison.Ordinal),
            "and never the prefix the packages are stored under, which serves no page");
        Assert(client.DownloadPage.Fragment == "#download-windows",
            "arriving readers land on the Windows download rather than having to find it");

        var older = await client.CheckAsync("9.9.9", "10.0.26100");
        Assert(older.Kind == AgentUpdateDecisionKind.UpToDate,
            "and a build that is already newer is still simply up to date");
    }

    // What the assertions above cannot know: whether that URL serves a page.
    //
    // Everything else here is about the shape of the address. The defect this
    // replaced was a well-formed HTTPS address on the right host that returned
    // AccessDenied, and no amount of inspecting the string finds that. Kept
    // out of the default run because a network failure is not a defect in this
    // code -- the same arrangement the macOS suite uses.
    if (Environment.GetEnvironmentVariable("RUN_AGENT_UPDATE_LIVE") == "1")
    {
        using var live = new WindowsAgentUpdateClient();

        // The whole of "check for updates", against what is actually
        // published, minus the mouse. A build old enough that anything
        // published is newer reaches the state the button belongs to.
        var offered = await live.CheckAsync("0.0.1", "10.0.26100");
        Assert(offered.Kind == AgentUpdateDecisionKind.DownloadManually,
            $"the live release is offered as a manual download, not as {offered.Kind}");
        Assert(offered.PublishedVersion is { Length: > 0 },
            "and it says which version it is offering");
        Console.WriteLine($"live: {offered.PublishedVersion} is offered as {offered.Kind}");

        // The same client on the published build. A release that tells its own
        // version it is out of date is an update loop, and that is exactly how
        // 0.5.49 would have behaved if its packages had shipped.
        var current = await live.CheckAsync(offered.PublishedVersion!, "10.0.26100");
        Assert(current.Kind == AgentUpdateDecisionKind.UpToDate,
            $"and the published version is up to date with itself, not {current.Kind}");

        using var browser = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        using var page = await browser.GetAsync(live.DownloadPage);
        Assert(page.IsSuccessStatusCode,
            $"the live download page answers, rather than {(int)page.StatusCode}");
        var type = page.Content.Headers.ContentType?.MediaType ?? "";
        Assert(type == "text/html",
            $"and answers with a page rather than {type}");
        var body = await page.Content.ReadAsStringAsync();
        Assert(body.Contains("download-windows", StringComparison.Ordinal),
            "and the page carries the Windows download the reader was sent for");
        Console.WriteLine("live: the download page serves HTML with a Windows download");
    }

    // A release the reader installs themselves, with the package still
    // published so the download page has something to offer.
    //
    // This is the shape the publisher writes for an unsigned platform: the
    // page needs the URL, and the agent must not act on it. Keying the
    // agent's behaviour on the package being absent would have forced the
    // page to go blank.
    {
        var manual = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            platform = "windows",
            version = "9.8.7",
            releasedAt = DateTimeOffset.UtcNow,
            install = "manual",
            packages = new[] { new { arch = WindowsAgentUpdateClient.HostArch, packageType = "msi",
                url = "https://dl.egressview.com/windows/EgressView.msi",
                sha256 = new string('b', 64), sizeBytes = 2048 } },
        });
        var verifier = new TestPackageVerifier();
        using var client = new WindowsAgentUpdateClient(new UpdateHandler(manual, []),
            verifier: verifier, manifestVerifier: new AcceptManifestVerifier());
        var decision = await client.CheckAsync("1.0.0", "10.0.26100");
        Assert(decision.Kind == AgentUpdateDecisionKind.DownloadManually && decision.PublishedVersion == "9.8.7",
            "a release marked for manual installation reports the version and hands over nothing to install");
        Assert(decision.Candidate is null && verifier.Calls == 0,
            "the package is not downloaded and not verified, however complete it looks");
    }

    // The relaxation goes exactly this far. A package that IS offered has to
    // be wholly valid: turning a malformed or unsigned one into "fetch it
    // yourself" would hide a manifest fault behind a helpful-looking message.
    {
        var unsigned = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            platform = "windows",
            version = "9.8.7",
            releasedAt = DateTimeOffset.UtcNow,
            packages = new[] { new { arch = WindowsAgentUpdateClient.HostArch, packageType = "msi",
                url = "https://dl.egressview.com/windows/EgressView.msi",
                sha256 = new string('a', 64), sizeBytes = 1024, publisher = "" } },
        });
        using var client = new WindowsAgentUpdateClient(new UpdateHandler(unsigned, []),
            verifier: new TestPackageVerifier(), manifestVerifier: new AcceptManifestVerifier());
        var rejected = false;
        try { await client.CheckAsync("1.0.0", "10.0.26100"); }
        catch (InvalidDataException exception) { rejected = exception.Message == "package-publisher-invalid"; }
        Assert(rejected, "a package offered without a publisher is a fault, not an invitation to download by hand");
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

    // A notification that can never say anything.
    //
    // The rule was "any '.' or ':'", which is not a test for a destination.
    // The outbound-anomaly notice is built from a clock time and a byte size,
    // so it matched every time: a real 2.10 GiB detection at 12:15 was
    // announced as "status changed", and could not have been announced as
    // anything else in any language. The same rule emptied every English body
    // in the product, because English sentences end in a period.
    Assert(NotificationRedaction.Apply("外向き通信が 12:15 に 2.10 GiB ありました。") == "外向き通信が 12:15 に 2.10 GiB ありました。",
        "a clock time and a byte size are not a destination and are left alone");
    Assert(NotificationRedaction.Apply("Outbound traffic at 12:15 was 2.10 GiB. Open the Agent for details.")
            == "Outbound traffic at 12:15 was 2.10 GiB. Open the Agent for details.",
        "and an English sentence is not redacted for ending in a full stop");
    Assert(NotificationRedaction.Apply("Delivery to the Hub is not completing. 10,000 observations are pending.")
            != NotificationRedaction.Replacement,
        "the Hub delivery notice survives in English as well as Japanese");

    // What the rule is actually for. Redacted whole, not patched, so nothing
    // is left to reconstruct the rest from.
    foreach (var named in new[]
    {
        "chrome talked to ads.example.com",
        "203.0.113.42 received 2 GiB",
        "2606:4700:10::1 received 2 GiB",
        "a connection to fe80::1 was seen",
    })
        Assert(NotificationRedaction.Apply(named) == NotificationRedaction.Replacement,
            $"a destination is kept off the desktop: {named}");

    // Suppressed attempts crowd out the ones that were shown.
    //
    // A degraded agent is re-evaluated on the UI's five-second refresh, and
    // every suppressed attempt was its own row in a list capped at a hundred.
    // Measured on a real machine: 94 of 100 slots held the same suppressed
    // message and a real outbound-anomaly notice was three rows from being
    // evicted by its own agent's noise.
    Assert(NotificationHistoryPolicy.RepeatsNewest("Monitoring", "要確認", "suppressed-cooldown",
            "Monitoring", "要確認", "suppressed-cooldown"),
        "the same suppressed attempt twice running is one entry with a count");
    Assert(!NotificationHistoryPolicy.RepeatsNewest("Monitoring", "要確認", "suppressed-cooldown",
            "HubDelivery", "要確認", "suppressed-cooldown"),
        "a different category is a different entry");
    Assert(!NotificationHistoryPolicy.RepeatsNewest("Monitoring", "要確認", "shown",
            "Monitoring", "要確認", "shown"),
        "two notifications actually shown are two events, because each one interrupted the reader");
    Assert(!NotificationHistoryPolicy.RepeatsNewest("Monitoring", "要確認", "suppressed-cooldown",
            "Monitoring", "要確認", "shown"),
        "and a suppressed attempt never folds into one that was shown");

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
    dnsNames.Observe("pid:42:start:1", "API.Bücher.Example.", "203.0.113.8;::ffff:203.0.113.9;", dnsAt);
    Assert(dnsNames.Resolve("pid:42:start:1", "203.0.113.8", dnsAt.AddSeconds(1)) == "api.xn--bcher-kva.example" &&
        dnsNames.Resolve("pid:42:start:1", "203.0.113.9", dnsAt.AddSeconds(1)) == "api.xn--bcher-kva.example",
        "DNS metadata is normalized with IDNA and IPv4-mapped addresses before bounded PID/IP correlation");
    Assert(dnsNames.Resolve("pid:42:start:2", "203.0.113.8", dnsAt.AddSeconds(1)) is null &&
        dnsNames.Resolve("pid:42:start:1", "203.0.113.8", dnsAt.AddMinutes(11)) is null,
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

        // Why delivery is where it is, in the bundle and not only on screen.
        //
        // This existed and reached the window over IPC. A Hub that answered
        // 400 to every batch carrying one malformed observation stopped
        // delivery for hours, and the bundle -- the thing a person sends when
        // they cannot work out what is wrong -- showed a pending count and a
        // capability that said "agreed". Finding the reason took reading the
        // live database and the Hub's own schema by hand.
        var stalled = DiagnosticsReport.Create(
            new CollectorSnapshot("healthy", 20, 20, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 32),
            reopened, "test",
            deliveryRuntime: new DeliveryRuntimeStatus("contract-rejected",
                LastAttemptAt: DateTimeOffset.UtcNow, NextRetryAt: DateTimeOffset.UtcNow.AddMinutes(5),
                LastFailure: "contract-rejected", LastFailureAt: DateTimeOffset.UtcNow, LastStatusCode: 400));
        using (var stalledJson = JsonDocument.Parse(stalled))
        {
            Assert(stalledJson.RootElement.GetProperty("delivery").TryGetProperty("runtime", out var runtime),
                "diagnostics carry the delivery runtime at all, which is the whole point of this");
            Assert(runtime.GetProperty("state").GetString() == "contract-rejected" &&
                runtime.GetProperty("lastFailure").GetString() == "contract-rejected" &&
                runtime.GetProperty("lastStatusCode").GetInt32() == 400 &&
                runtime.TryGetProperty("nextRetryAt", out _),
                "diagnostics say why delivery stopped and what the Hub answered, not only how much is pending");
        }
        Assert(JsonDocument.Parse(report).RootElement.GetProperty("delivery")
                .GetProperty("runtime").ValueKind == JsonValueKind.Null,
            "and say nothing rather than guessing when the caller has no delivery controller to ask");

        // The failure is free text on the way in. A path or a host reaching it
        // must be reduced the way collector failures already are.
        var leaky = DiagnosticsReport.Create(
            new CollectorSnapshot("healthy", 20, 20, 0, 0, DateTimeOffset.UtcNow, DateTimeOffset.UtcNow, 32),
            reopened, "test",
            deliveryRuntime: new DeliveryRuntimeStatus("retryable", LastFailure: "retryable: https://hub.secret.example/api"));
        Assert(leaky.Contains("retryable", StringComparison.Ordinal) && !leaky.Contains("secret", StringComparison.Ordinal),
            "a free-text delivery failure is reduced to a safe classification before export");

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

    using (var identityStore = new ObservationStore(Path.Combine(directory, "process-instances.db")))
    {
        var at = DateTimeOffset.UtcNow;
        identityStore.WriteBatch([
            new NetworkObservation(at, 77, "UDP", "10.0.0.1", 5353, "203.0.113.1", 5353,
                10, 1, ObservationLayer.Logical, null, "etw", "Browser", ProcessInstanceId: "pid:77:start:1"),
            new NetworkObservation(at.AddSeconds(1), 77, "UDP", "10.0.0.1", 5353, "203.0.113.2", 5353,
                20, 2, ObservationLayer.Logical, null, "etw", "Browser", ProcessInstanceId: "pid:77:start:1"),
            new NetworkObservation(at.AddSeconds(2), 77, "UDP", "10.0.0.1", 5353, "203.0.113.1", 5353,
                30, 3, ObservationLayer.Logical, null, "etw", "Agent", ProcessInstanceId: "pid:77:start:2"),
        ]);
        var identities = identityStore.ReadRecentFlows(50);
        Assert(identities.Count == 3 && identities.Select(row => row.ProcessInstanceId).Distinct().Count() == 2,
            "UDP peers and a reused PID are stored as three immutable flow identities");

        identityStore.BeginCoverage([
            new StartupFlow("UDP", "0.0.0.0", 5353, "", 0, 77, "Agent", "pid:77:start:2")
        ], at.AddSeconds(3));
        Assert(identityStore.ReadRecentFlows(50).Count == 3,
            "a startup UDP socket with no peer remains a coverage placeholder and not a product flow");
    }

    var coverageDatabase = Path.Combine(directory, "coverage.db");
    using (var coverageStore = new ObservationStore(coverageDatabase))
    {
        var started = DateTimeOffset.UtcNow;
        var snapshot = new[]
        {
            new StartupFlow("TCP", "10.0.0.1", 50000, "10.0.0.2", 443, 99, "SnapshotApp", "pid:99:start:1"),
            new StartupFlow("TCP", "10.0.0.1", 50001, "10.0.0.3", 443, 99, "SnapshotApp", "pid:99:start:1"),
        };
        var firstCoverage = coverageStore.BeginCoverage(snapshot, started);
        await using (var flowPipeline = new ObservationPipeline(coverageStore))
        {
            Assert(flowPipeline.TrySubmit(new NetworkObservation(started.AddSeconds(1), 99, "TCP",
                "10.0.0.1", 50000, "10.0.0.2", 443, 128, 0,
                ObservationLayer.Logical, "test", "etw", "EtwApp", ProcessInstanceId: "pid:99:start:1")), "ETW flow accepted");
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

        // The ratio above is true and easy to miss. The same intervals say
        // where the missing time is, and until now the chart drew those
        // minutes exactly like minutes with no traffic.
        Assert(crashWindow.MonitoringGaps.Count == 1
               && crashWindow.MonitoringGaps[0] == new MonitoringGap(started.AddSeconds(5), started.AddSeconds(10))
               && crashWindow.MonitoringGapSeconds == 5,
            "the time an abrupt termination left unaccounted for is reported as a gap, not as quiet");

        // Sleep is already drawn in its own colour. Reporting it again here
        // would put two bands over the same minutes and make one stretch of
        // unknown time look like two different things.
        Assert(suspendWindow.MonitoringGaps.Count == 0 && suspendWindow.MonitoringGapSeconds == 0,
            "a gap that is entirely sleep is left to the sleep disclosure rather than reported twice");

        // A period from before the Agent ever ran is not a quiet period.
        var beforeAnything = coverageStore.ReadPeriodAnalysis(started.AddSeconds(-100), started.AddSeconds(-50));
        Assert(beforeAnything.CoverageRatio == 0
               && beforeAnything.MonitoringGaps.Count == 1
               && beforeAnything.MonitoringGapSeconds == 50,
            "a period with no coverage at all is one gap, not an empty chart");

        // One outage with a sleep inside it is two stretches of "nobody was
        // watching" separated by one the user asked for.
        var partial = coverageStore.BeginCoverage(snapshot, started.AddSeconds(30));
        coverageStore.InterruptCoverage(partial, started.AddSeconds(32));
        coverageStore.BeginSleepPeriod(started.AddSeconds(40));
        coverageStore.EndSleepPeriod(started.AddSeconds(45));
        var recovered = coverageStore.BeginCoverage(snapshot, started.AddSeconds(50));
        coverageStore.EndCoverage(recovered, started.AddSeconds(52));
        var splitWindow = coverageStore.ReadPeriodAnalysis(started.AddSeconds(30), started.AddSeconds(52));
        Assert(splitWindow.MonitoringGaps.Count == 2
               && splitWindow.MonitoringGaps[0] == new MonitoringGap(started.AddSeconds(32), started.AddSeconds(40))
               && splitWindow.MonitoringGaps[1] == new MonitoringGap(started.AddSeconds(45), started.AddSeconds(50))
               && splitWindow.MonitoringGapSeconds == 13,
            "a sleep inside an outage splits it, leaving only the part nobody asked for");
        var clippedSleep = coverageStore.ReadSleepPeriods(started.AddSeconds(14), started.AddSeconds(18));
        Assert(clippedSleep.SequenceEqual([new SleepPeriod(started.AddSeconds(14), started.AddSeconds(18))]),
            "sleep disclosure is clipped to the selected chart period");
    }

    // A privacy claim the screen makes about its own network use. The card
    // used to carry both "this sends watched addresses outside", in a warning
    // under the radio buttons, and "observed destinations are never sent", in
    // the summary above them -- and the wrong one was the summary.
    {
        var none = EnrichmentDisclosure.Describe(false, false, false, "ipwho", "feeds", "maxmind");
        Assert(none.Key == EnrichmentDisclosure.HubOnlyKey && none.Sources.Count == 0,
            "with nothing fetched directly, the screen may say the Hub is the only source");

        var downloads = EnrichmentDisclosure.Describe(false, true, true, "ipwho", "feeds", "maxmind");
        Assert(downloads.Key == EnrichmentDisclosure.DownloadOnlyKey
               && downloads.Sources.SequenceEqual(["feeds", "maxmind"]),
            "sources that only download may be described as downloads");

        foreach (var (feeds, table) in new[] { (false, false), (true, false), (false, true), (true, true) })
        {
            var outside = EnrichmentDisclosure.Describe(true, feeds, table, "ipwho", "feeds", "maxmind");
            Assert(outside.Key == EnrichmentDisclosure.SendsAddressesKey,
                $"the third-party lookup is never described as download-only (feeds={feeds}, table={table})");
            Assert(outside.Sources.Contains("ipwho"),
                "and the source that is sent addresses is named");
        }
    }

    // What the Agent is doing while it cannot say anything. A migration runs
    // inside the store's constructor, so the pipe does not exist yet; the file
    // beside the database is the only thing a window can read.
    {
        var progressDb = Path.Combine(directory, "progress.db");
        Assert(MigrationProgress.Read(progressDb) is null,
            "a database that is not being migrated reports nothing");

        var at = DateTimeOffset.UtcNow;
        MigrationProgress.Write(progressDb, new(25, 26, MigrationProgress.MovingRows, 31_387_127, at));
        var read = MigrationProgress.Read(progressDb);
        Assert(read is { FromVersion: 25, ToVersion: 26, Rows: 31_387_127 }
               && read.Phase == MigrationProgress.MovingRows,
            "and one that is reports the versions, the phase and how much there is to move");
        // The scale of the wait is the point. "43%" invites watching a number
        // that does not move for a minute at a time.
        Assert(read!.Rows > 0, "the row count is what makes the wait explicable");

        MigrationProgress.Clear(progressDb);
        Assert(MigrationProgress.Read(progressDb) is null, "and it stops reporting once the schema is whole");

        // The window is in ui\ and the service in service\, both under one
        // installation root, so the file can be found without a registry key.
        var located = MigrationProgress.ServiceDatabaseFrom(@"C:\Program Files\EgressView Agent\ui\");
        Assert(located.EndsWith(Path.Combine("service", "data", "egressview-agent.db"), StringComparison.OrdinalIgnoreCase)
               && !located.Contains(@"ui\", StringComparison.OrdinalIgnoreCase),
            $"the window finds the service's database beside its own directory, not {located}");
    }

    // A real migration writes it. The v1 fixture goes through every version,
    // so it passes the phase that takes the time.
    {
        var watched = Path.Combine(directory, "watched-v1.db");
        ObservationStore.CreateVersion1FixtureForTesting(watched);
        var reported = new List<MigrationProgress>();
        using (var migrating = new ObservationStore(watched, reported.Add))
            Assert(migrating.SchemaVersion == 29, "the fixture migrated");

        // One per migration that rewrites the table: v26 moved the flow off
        // the row and v27 the time, and each says so before it starts.
        var movingSteps = reported.Where(step => step.Phase == MigrationProgress.MovingRows).ToArray();
        var movingVersions = movingSteps.Select(step => step.ToVersion).Distinct().Count();
        Assert(movingVersions == 4,
            $"each migration that takes time says so before it starts, not {movingVersions} of them");
        // The one that moves the observations. v28 rewrites the folded hours,
        // of which this fixture has none, so taking "the last" asked the
        // wrong migration how much work it had.
        var moving = movingSteps.Single(step => step.ToVersion == 27 && step.Step == 2);
        Assert(moving is not null, "the phase that takes the time says so before it starts");
        // Four, because the fixture has four. A report of zero reads as "this
        // will be quick" for a wait that is anything but, and a number nobody
        // checks is a number that drifts to zero.
        Assert(moving!.Rows == 4,
            $"and says how many rows there are to move, not {moving.Rows}");
        Assert(moving.ToVersion == 27 && moving.FromVersion == 26,
            "and which version it is moving them to");
        Assert(movingSteps.Any(step => step.ToVersion == 28),
            "and the folded hours are rewritten too, however few of them there are");
        Assert(reported.Any(step => step.Phase == MigrationProgress.BackingUp),
            "the copy that happens first is reported first");
        Assert(MigrationProgress.Read(watched) is null,
            "a finished migration leaves nothing behind for the window to misread as ongoing");
        Assert(!File.Exists(MigrationProgress.PathFor(watched)),
            "and the file itself is gone");

        // Where it is, not only what it is doing (P3-165). On 2026-09-23 a
        // migration that could not finish and one that was merely slow read
        // the same for twenty-five minutes, because the file said "moving
        // rows" and nothing else.
        foreach (var (version, length) in new[] { (26, 4), (27, 3), (28, 3), (29, 8) })
        {
            var steps = reported.Where(step => step.ToVersion == version).ToArray();
            var positions = steps.Select(step => step.Step).ToArray();
            Assert(positions.SequenceEqual(Enumerable.Range(1, length)),
                $"v{version} reports every step once and in order, not [{string.Join(",", positions)}]");
            Assert(steps.All(step => step.Steps == length),
                $"and every report of v{version} says how many steps there are");
            // The clock a reader wants is "how long has this been going", so
            // it is the start of the migration, not of the step.
            Assert(steps.Select(step => step.At).Distinct().Count() == 1,
                $"and v{version} keeps one start time across its steps");
            Assert(steps.All(step => step.ProcessId == Environment.ProcessId && step.Heartbeat is not null),
                $"and every report of v{version} says who wrote it and when they were last alive");
        }
        // The copy is step one; the rewriting of 31 million rows is not
        // described as still making it. It used to be, for 43 seconds.
        var v29 = reported.Where(step => step.ToVersion == 29).ToArray();
        Assert(v29[0].Phase == MigrationProgress.BackingUp && v29[1].Phase == MigrationProgress.MovingRows,
            "v29 says it is moving rows before the first rewrite, not after it");
        Assert(v29[^1].Phase == MigrationProgress.Finishing,
            "and says it is finishing while it swaps the tables and commits");
    }

    // Whether what the file describes is still going on (P3-166). On
    // 2026-09-23 the service was stopped mid-migration and the tray went on
    // saying "updating" for as long as anyone looked, about a migration
    // nothing was running.
    {
        var now = DateTimeOffset.UtcNow;
        bool Alive(int _) => true;
        bool Gone(int _) => false;
        var fresh = new MigrationProgress(28, 29, MigrationProgress.MovingRows, 31_647_027, now.AddMinutes(-4),
            5, 8, 4242, now.AddSeconds(-2));

        Assert(fresh.StateAt(now, Alive) == MigrationState.Running,
            "a writer that is there and beat two seconds ago is running");
        Assert(fresh.StateAt(now, Gone) == MigrationState.Interrupted,
            "a writer whose process is gone is interrupted at once, whatever its last beat says");
        // The PID is reused; a new process that happens to get it must not
        // keep a dead migration looking alive. The heartbeat is what catches
        // that.
        var stale = fresh with { Heartbeat = now - MigrationProgress.StaleAfter - TimeSpan.FromSeconds(1) };
        Assert(stale.StateAt(now, Alive) == MigrationState.Interrupted,
            "a heartbeat older than StaleAfter is interrupted even when some process holds the PID");
        var justInside = fresh with { Heartbeat = now - MigrationProgress.StaleAfter + TimeSpan.FromSeconds(1) };
        Assert(justInside.StateAt(now, Alive) == MigrationState.Running,
            "and one just inside it is not");
        Assert((fresh with { Phase = MigrationProgress.Failed }).StateAt(now, Gone) == MigrationState.Failed,
            "a migration that said it failed is failed, not interrupted, whatever happened to its writer");
        // Written by a version from before any of this: taken at its word,
        // which is what the window did before.
        var legacy = new MigrationProgress(25, 26, MigrationProgress.MovingRows, 10, now.AddHours(-3));
        Assert(legacy.StateAt(now, Gone) == MigrationState.Running,
            "a file with no heartbeat cannot be judged and is described as it says");

        // The new fields survive the file, and the old five-field line still
        // reads.
        var roundTrip = Path.Combine(directory, "round-trip.db");
        MigrationProgress.Write(roundTrip, fresh);
        var back = MigrationProgress.Read(roundTrip);
        Assert(back is { Step: 5, Steps: 8, ProcessId: 4242 } && back.Heartbeat == fresh.Heartbeat && back.At == fresh.At,
            $"the position, the writer and the heartbeat survive the file, not {back}");
        File.WriteAllText(MigrationProgress.PathFor(roundTrip),
            string.Join('\t', "25", "26", MigrationProgress.MovingRows, "10", now.ToString("O")));
        var old = MigrationProgress.Read(roundTrip);
        Assert(old is { FromVersion: 25, ToVersion: 26, Rows: 10, Steps: 0, Heartbeat: null },
            "a five-field file from before still reads");
        MigrationProgress.Clear(roundTrip);

        // This process is running; a PID that no process can have is not.
        Assert(MigrationProgress.ProcessIsRunning(Environment.ProcessId),
            "the running process is found");
        Assert(!MigrationProgress.ProcessIsRunning(int.MaxValue),
            "and one that cannot exist is not");
    }

    // The heartbeat beats on its own, and stops for good. A statement of the
    // v29 migration took 134 seconds; a heartbeat that waited for it would
    // make a working migration look dead.
    {
        var beating = Path.Combine(directory, "beating.db");
        var reporter = new MigrationReporter(beating, TimeSpan.FromMilliseconds(40));
        var first = reporter.Report(28, 29, MigrationProgress.MovingRows, 100, 6, 8);
        Thread.Sleep(400);
        var later = MigrationProgress.Read(beating);
        Assert(later is not null && later.Heartbeat > first.Heartbeat,
            "the heartbeat moves while nothing else does");
        Assert(later!.Step == 6 && later.At == first.At,
            "and it repeats the step it was given rather than inventing one");

        reporter.Stop();
        var stoppedAt = MigrationProgress.Read(beating)!.Heartbeat;
        Thread.Sleep(300);
        Assert(MigrationProgress.Read(beating)!.Heartbeat == stoppedAt,
            "once stopped it does not beat again");
        MigrationProgress.Clear(beating);
        Thread.Sleep(200);
        Assert(!File.Exists(MigrationProgress.PathFor(beating)),
            "and a finished migration's file, once cleared, is not written back by a late beat");
        reporter.Dispose();
    }

    // A migration that stops has to say so. Left alone, the file keeps the
    // phase it never got past, and the window goes on describing an Agent
    // that has given up as one still working.
    {
        var doomed = Path.Combine(directory, "doomed-v1.db");
        // v26 creates observations_v26 and this is already there, so the
        // migration fails partway -- after the earlier versions have run.
        ObservationStore.CreateVersion1FixtureForTesting(doomed, "CREATE TABLE observations_v26(x INTEGER);");
        var threw = false;
        try { using var _ = new ObservationStore(doomed); }
        catch (ObservationStoreException) { threw = true; }
        Assert(threw, "a migration that cannot finish does not pretend the database is open");

        var left = MigrationProgress.Read(doomed);
        Assert(left is not null, "and it leaves something for the window to read");
        Assert(left!.Phase == MigrationProgress.Failed,
            $"which says it stopped rather than the phase it never got past, not {left.Phase}");
        // Twenty-six, not the newest: the fixture is rigged to fail there,
        // and what the report has to carry is the step that stopped.
        Assert(left.ToVersion == 26, "and which version it was trying to reach");
        // And where in it: step one of four, the copy, because the table the
        // fixture planted makes the schema change after it fail.
        Assert(left.Step == 1 && left.Steps == 4,
            $"and how far it got, not step {left.Step} of {left.Steps}");
        Assert(left.StateAt(DateTimeOffset.UtcNow) == MigrationState.Failed,
            "and it reads as failed, not as interrupted, now that its writer has moved on");
    }

    // Why it failed has to reach a diagnostics bundle (P3-161). The service
    // wrote the reason to startup-error.txt and nothing read it: the window
    // said "the update failed, the diagnostics export says why", and the
    // export -- saved while the service was down -- recordedFailures the window's own
    // pipe timeout instead.
    {
        var failedData = Path.Combine(directory, "failed-service");
        Directory.CreateDirectory(failedData);
        var failedDb = Path.Combine(failedData, "egressview-agent.db");
        ObservationStore.CreateVersion1FixtureForTesting(failedDb, "CREATE TABLE observations_v26(x INTEGER);");
        Exception? caughtFailure = null;
        try { using var _ = new ObservationStore(failedDb); }
        catch (Exception exception) { caughtFailure = exception; }
        Assert(caughtFailure is ObservationStoreException, $"the rigged migration fails as a store failure, not {caughtFailure?.GetType().Name}");

        // What the service does on its way out.
        ServiceFailure.Append(failedData, ServiceFailure.From(caughtFailure!, failedDb, DateTimeOffset.UtcNow));
        var recordedFailures = ServiceFailure.Read(failedData);
        Assert(recordedFailures.Count == 1 && recordedFailures[0].ExceptionType == nameof(ObservationStoreException)
               && recordedFailures[0].StoreFailure is not null,
            "the failure is recorded with its type and the store's own classification");
        Assert(recordedFailures[0].Migration is { FromVersion: 25, ToVersion: 26, Step: 1, Steps: 4 },
            $"and with where it stopped, not {recordedFailures[0].Migration}");

        // The bundle a window saves while the service is down carries it,
        // beside -- not instead of -- why the window could not ask.
        var withFailure = DiagnosticsReport.CreateFallback("0.0.0", "TimeoutException", failedData);
        using (var failureDocument = System.Text.Json.JsonDocument.Parse(withFailure))
        {
            var failureRoot = failureDocument.RootElement;
            Assert(failureRoot.GetProperty("service").GetProperty("failure").GetString() == "TimeoutException",
                "the window's own failure is still said");
            var failureList = failureRoot.GetProperty("serviceFailures");
            Assert(failureList.GetArrayLength() == 1
                   && failureList[0].GetProperty("exceptionType").GetString() == nameof(ObservationStoreException)
                   && failureList[0].GetProperty("migration").GetProperty("toVersion").GetInt32() == 26
                   && failureList[0].GetProperty("migration").GetProperty("step").GetInt32() == 1,
                $"and the service's failure is carried with its step: {failureList}");
        }
        var failureSummary = DiagnosticsBundle.RenderText(withFailure);
        Assert(failureSummary.Contains("Service failures on record: 1; latest", StringComparison.Ordinal)
               && failureSummary.Contains("during the migration to schema v26, step 1 of 4", StringComparison.Ordinal),
            $"and diagnostics.txt says it in a sentence: {failureSummary}");

        // The message stays on the machine. An IOException names a path and a
        // SQLite error can quote one; the bundle promises neither.
        var leakyFailure = new IOException(@"C:\Users\someone\secret.db could not reach api.example.com");
        ServiceFailure.Append(failedData, ServiceFailure.From(leakyFailure, failedDb, DateTimeOffset.UtcNow));
        var failureFile = File.ReadAllText(Path.Combine(failedData, ServiceFailure.FileName));
        var leakReport = DiagnosticsReport.CreateFallback("0.0.0", "TimeoutException", failedData);
        foreach (var (name, text) in new[] { ("the file", failureFile), ("the report", leakReport), ("the summary", DiagnosticsBundle.RenderText(leakReport)) })
            Assert(!text.Contains("secret", StringComparison.OrdinalIgnoreCase)
                   && !text.Contains("example.com", StringComparison.OrdinalIgnoreCase)
                   && !text.Contains("someone", StringComparison.OrdinalIgnoreCase),
                $"{name} carries no part of the exception's message");
        Assert(ServiceFailure.Read(failedData)[^1].ExceptionType == nameof(IOException),
            "while the type still says what kind of failure it was");

        // Kept once the progress failureFile is gone -- the next successful start
        // clears that failureFile, and that is exactly when someone asks why the
        // start before it failed.
        MigrationProgress.Clear(failedDb);
        Assert(ServiceFailure.Read(failedData).Count == 2, "the record outlives the progress file");

        // And bounded: a service failing on every start does not grow a failureFile
        // without end.
        var failNow = DateTimeOffset.UtcNow;
        for (var i = 0; i < 10; i++)
            ServiceFailure.Append(failedData, new ServiceFailure(failNow.AddSeconds(i), "Repeated", null, null));
        var keptFailures = ServiceFailure.Read(failedData);
        Assert(keptFailures.Count == ServiceFailure.Kept && keptFailures[^1].At == failNow.AddSeconds(9),
            $"only the last {ServiceFailure.Kept} are kept, newest last, not {keptFailures.Count}");

        // A leakReport from a service that is runningReport again carries them too.
        var healthyData = Path.Combine(directory, "healthy-service");
        Directory.CreateDirectory(healthyData);
        using (var healthy = new ObservationStore(Path.Combine(healthyData, "egressview-agent.db")))
        {
            var quietReport = DiagnosticsReport.Create(new CollectorSnapshot("running", 0, 0, 0, 0, null, null, 0), healthy, "0.0.0");
            Assert(DiagnosticsBundle.RenderText(quietReport).Contains("Service failures on record: none recorded", StringComparison.Ordinal),
                "a service that never failed says so rather than leaving the line out");
            ServiceFailure.Append(healthyData, recordedFailures[0]);
            var runningReport = DiagnosticsReport.Create(new CollectorSnapshot("running", 0, 0, 0, 0, null, null, 0), healthy, "0.0.0");
            using var failureDocument = System.Text.Json.JsonDocument.Parse(runningReport);
            Assert(failureDocument.RootElement.GetProperty("serviceFailures").GetArrayLength() == 1,
                "and one that failed before and is running now still carries why");
        }
    }

    // The window is headed "outbound traffic from this PC" and its
    // destination list carried 127.0.0.1 -- 41,680 rows in a day on the
    // machine this was found on, the longest-lived flow there was.
    {
        foreach (var inside in new[] { "127.0.0.1", "127.53.1.9", "::1", "0:0:0:0:0:0:0:1" })
            Assert(DestinationScope.IsLoopback(inside), $"{inside} never left this PC");
        // The line is the network card, not the router. These do leave.
        foreach (var outside in new[] { "192.168.1.1", "10.0.0.5", "224.0.0.251", "ff02::fb", "169.254.1.1", "93.184.216.34" })
            Assert(!DestinationScope.IsLoopback(outside), $"{outside} left this PC, however far it got");
        Assert(!DestinationScope.IsLoopback(null) && !DestinationScope.IsLoopback("")
               && !DestinationScope.IsLoopback("not-an-address"),
            "and nothing that is not an address is claimed to be loopback");
        // The two answers have to agree: an address SQL calls loopback and
        // C# calls outbound would be counted in both halves.
        Assert(DestinationScope.LoopbackSql().Contains("127.%", StringComparison.Ordinal)
               && DestinationScope.LoopbackSql("f").Contains("f.remote_address", StringComparison.Ordinal),
            "and the SQL asks the same question, of whichever table it is given");

        // And the counts actually use it. A classifier nothing calls is a
        // classifier, not a fix.
        var scopeDatabase = Path.Combine(directory, "scope.db");
        using var scopeStore = new ObservationStore(scopeDatabase);
        var scopeAt = DateTimeOffset.UtcNow.AddMinutes(-5);
        scopeStore.WriteBatch([
            new NetworkObservation(scopeAt, 10, "TCP", "10.1.1.1", 4000, "93.184.216.34", 443, 100, 100,
                ObservationLayer.Logical, null, "etw", "outward"),
            new NetworkObservation(scopeAt, 10, "TCP", "10.1.1.1", 4001, "192.168.1.9", 445, 100, 100,
                ObservationLayer.Logical, null, "etw", "outward"),
            new NetworkObservation(scopeAt, 11, "TCP", "127.0.0.1", 4002, "127.0.0.1", 9000, 100, 100,
                ObservationLayer.Logical, null, "etw", "inward"),
        ]);
        var scoped = scopeStore.ReadPeriodAnalysis(scopeAt.AddMinutes(-1), DateTimeOffset.UtcNow);
        Assert(scoped.Connections == 2 && scoped.Destinations == 2,
            $"the headline counts only what left this PC, not {scoped.Connections}/{scoped.Destinations}");
        Assert(scoped.LocalConnections == 1 && scoped.LocalDestinations == 1,
            $"and what stayed inside is counted, not dropped: {scoped.LocalConnections}/{scoped.LocalDestinations}");
        Assert(scoped.Links.All(link => link.Destination != "127.0.0.1"),
            "and the destination chart agrees with the number above it");

        // How many destinations arrived with a name (P3-162). A reader turned
        // the setting on, saw addresses in the chart, and concluded it had not
        // worked -- Secure DNS and direct addresses leave nothing to read, and
        // there was no way to tell that apart from a broken setting.
        //
        // Counted from the rows the chart is built from, so the card and the
        // chart cannot be describing different populations. Not from DNS
        // events: those answer a different question about a different set.
        Assert(scoped.NamedDestinations == 0 && scoped.Destinations == 2,
            $"with nothing resolved, none of the destinations are named: {scoped.NamedDestinations}/{scoped.Destinations}");

        var namedAt = scopeAt.AddSeconds(1);
        scopeStore.WriteBatch([
            new NetworkObservation(namedAt, 12, "TCP", "10.1.1.1", 4010, "93.184.216.34", 443, 10, 10,
                ObservationLayer.Logical, null, "etw", "outward", "example.com"),
            // The address written out again is what the chart falls back to,
            // and it must not be counted as a name. NormalizeDomain is where
            // that is decided -- it returns null for anything that parses as
            // an address -- so this row proves the invariant holds end to
            // end rather than that a second check in SQL catches it.
            new NetworkObservation(namedAt, 13, "TCP", "10.1.1.1", 4011, "198.51.100.7", 443, 10, 10,
                ObservationLayer.Logical, null, "etw", "outward", "198.51.100.7"),
            // A second connection to a destination already counted once. With
            // one connection each, counting connections and counting distinct
            // addresses give the same answer, and a mutation that counted the
            // wrong one survived -- it did. Here the two answers are 2 and 1.
            new NetworkObservation(namedAt, 14, "TCP", "10.1.1.1", 4012, "93.184.216.34", 8443, 10, 10,
                ObservationLayer.Logical, null, "etw", "outward", "example.com"),
        ]);
        var withNames = scopeStore.ReadPeriodAnalysis(scopeAt.AddMinutes(-1), DateTimeOffset.UtcNow);
        Assert(withNames.Destinations == 3 && withNames.NamedDestinations == 1,
            $"only the destination that actually resolved is named: {withNames.NamedDestinations}/{withNames.Destinations}");
        Assert(withNames.NamedDestinations <= withNames.Destinations,
            "and the share can never exceed one");
        // The chart's own population, counted independently: the card's
        // denominator has to be the same addresses, or the two disagree on
        // screen while both look right on their own.
        Assert(withNames.Links.Select(link => link.Destination).Distinct().Count() == withNames.Destinations,
            "the card counts the destinations the chart draws, not a different set");

        // The same question over connections, which is a different answer.
        // On the machine this was written for the two were 93% and 11%: the
        // destinations that resolve are the majority, and the ones that do
        // not carry almost all the traffic. A reader shown only the first
        // sees a high percentage above a chart that is nearly all addresses.
        Assert(withNames.NamedConnections == 2 && withNames.Connections == 5,
            $"connections are counted too, not {withNames.NamedConnections}/{withNames.Connections}");
        // Two connections, one address: counting the wrong one shows here.
        Assert(withNames.NamedConnections != withNames.NamedDestinations,
            "counted over connections, not over addresses a second time");
        Assert(withNames.NamedConnections <= withNames.Connections,
            "and that share can never exceed one either");
        // And so does the chart under them. Before v28 the timeline read
        // chart_hourly, which folds by application and has no destination to
        // filter on, so the tiles said one thing and the picture below said
        // another.
        Assert(scoped.Timeline.Sum(item => item.Connections) == 2,
            $"the timeline counts what the tiles count, not {scoped.Timeline.Sum(item => item.Connections)}");

        // Again through the fold, because the raw tail is not the path that
        // was broken. chart_hourly folds by application and had no scope to
        // filter on, so a period read from summaries counted the loopback
        // flow while the tiles above it did not -- and a test that only
        // covers the unfolded hours cannot see that.
        var foldedHour = new DateTimeOffset(2026, 9, 1, 3, 0, 0, TimeSpan.Zero);
        var foldedDatabase = Path.Combine(directory, "scope-folded.db");
        using var foldedStore = new ObservationStore(foldedDatabase);
        foldedStore.WriteBatch([
            new NetworkObservation(foldedHour.AddMinutes(5), 20, "TCP", "10.1.1.1", 5000, "93.184.216.34", 443,
                100, 100, ObservationLayer.Logical, null, "etw", "outward"),
            new NetworkObservation(foldedHour.AddMinutes(6), 21, "TCP", "127.0.0.1", 5001, "127.0.0.1", 9000,
                500, 500, ObservationLayer.Logical, null, "etw", "inward"),
        ]);
        var settled = foldedHour.AddHours(2).AddMinutes(10);
        while (foldedStore.PendingChartFoldHours(settled) > 0) foldedStore.FoldCompletedHoursForCharts(settled);

        // Five days, so a bucket is longer than an hour and the timeline reads
        // the fold. Under an hour it reads everything raw (P3-149), which is
        // the path the previous version of this test was accidentally taking
        // -- it passed while the fold it claimed to cover was never touched.
        var foldedFrom = foldedHour.AddDays(-2);
        var foldedTo = foldedHour.AddDays(3);
        var folded = foldedStore.ReadPeriodAnalysis(foldedFrom, foldedTo);
        Assert(folded.Timeline.Sum(item => item.Connections) == 1,
            $"a folded hour counts only what left this PC, not {folded.Timeline.Sum(item => item.Connections)}");
        Assert(folded.Timeline.All(item => item.Application != "inward"),
            "and the application that only talked to itself is not in the chart");
        Assert(folded.BytesSent + folded.BytesReceived == 200,
            $"and the bytes agree with it, not {folded.BytesSent + folded.BytesReceived}");
        Assert(!folded.IncludesUnseparatedHours,
            "an hour folded by this version has nothing it could not separate");

        // An hour folded before v28, which the migration marks 'mixed'
        // because that is what it is. It has to keep being counted -- dropping
        // it would empty the chart rather than qualify it -- and the window
        // has to say it is there.
        foldedStore.SeedFoldedHourForTesting(foldedHour, "legacy", "mixed", 7, 900);
        var withLegacy = foldedStore.ReadPeriodAnalysis(foldedFrom, foldedTo);
        Assert(withLegacy.Timeline.Sum(item => item.Connections) == 8,
            $"an hour that could not be separated is still counted, not {withLegacy.Timeline.Sum(item => item.Connections)}");
        Assert(withLegacy.IncludesUnseparatedHours,
            "and the window is told, so a mixed figure is not presented as a clean one");

        // 'local' is the other half of the same fold and must not be counted.
        foldedStore.SeedFoldedHourForTesting(foldedHour, "inward-only", "local", 99, 99_000);
        var withLocal = foldedStore.ReadPeriodAnalysis(foldedFrom, foldedTo);
        Assert(withLocal.Timeline.Sum(item => item.Connections) == 8,
            $"and what the fold knew stayed here is left out, not {withLocal.Timeline.Sum(item => item.Connections)}");
    }

    // The grace the window and the notification both use. Two numbers here
    // would be two opinions about whether delivery is stuck, and the screen
    // would contradict the alert it is standing in for.
    Assert(DeliveryNotificationTracker.OutageGrace == TimeSpan.FromMinutes(5),
        "the screen and the outage notification share one definition of stuck");

    var liveSnapshot = StartupSnapshot.Capture();
    Assert(liveSnapshot.Where(flow => flow.Protocol == "TCP").All(flow => flow.RemotePort > 0),
        "TCP startup snapshot excludes listeners");

    var legacyDatabase = Path.Combine(directory, "legacy-v1.db");
    ObservationStore.CreateVersion1FixtureForTesting(legacyDatabase);
    using (var migrated = new ObservationStore(legacyDatabase))
    {
        Assert(migrated.SchemaVersion == 29, "v1 database migrates through v2-v29");
        Assert(!migrated.DeliveryEnabled, "delivery is opt-in after migration");
        Assert(migrated.Inspect().Integrity == "ok", "migrated database integrity is ok");

        // The fixture carries four observations from before the flows table
        // existed, which is the case v26 has to survive: rows with nothing to
        // point at. Refusing would turn a database the Agent can still read
        // into one it will not open.
        var carried = migrated.ReadRecentObservations(50);
        Assert(carried.Count == 4, $"every pre-flows observation survives the normalisation, not {carried.Count}");

        // And arrives with the flow rebuilt around it. The two TCP rows are
        // one connection; the two UDP rows are one socket that spoke to two
        // peers, which is the case that stops the remote end being moved onto
        // the flow.
        var tcp = carried.Where(flow => flow.Protocol == "TCP").ToArray();
        var udp = carried.Where(flow => flow.Protocol == "UDP").ToArray();
        Assert(tcp.Length == 2 && tcp.All(flow => flow.LocalAddress == "10.1.1.1" && flow.LocalPort == 50000
                                                  && flow.RemoteAddress == "93.184.216.34" && flow.ProcessId == 4242),
            "a rebuilt TCP flow keeps the local end, the remote end and the process it belonged to");
        Assert(udp.Length == 2 && udp.Select(flow => flow.RemoteAddress).Distinct().Count() == 2,
            "and one UDP socket keeps both of the peers it spoke to, which only the observation rows know");
        var migratedFlows = migrated.ReadRecentFlows(50);
        Assert(migratedFlows.Count == 3 && migratedFlows.Count(flow => flow.Protocol == "UDP") == 2,
            "v29 separates legacy UDP peers into destination flows");
        Assert(migratedFlows.Sum(flow => flow.BytesSent ?? 0) == carried.Sum(flow => flow.BytesSent ?? 0) &&
               migratedFlows.All(flow => flow.ProcessInstanceId?.StartsWith("legacy:", StringComparison.Ordinal) == true),
            "migration preserves observed bytes and marks unrecoverable ownership as legacy rather than inventing a start time");
        Assert(carried.All(flow => flow.InterfaceId == "iface-1"),
            "the interface comes back through the flow it was moved to");

        // The fraction of a second, which v27 rewrites as ticks. The fixture
        // carries whole seconds, so a conversion that dropped the fraction
        // entirely would still pass everything above -- and did: substr at 20
        // takes the decimal point with it and casts to zero, and every row in
        // a real database lost its hundred nanoseconds. Only a fixture with a
        // fraction in it can say so.
        Assert(carried.Any(flow => flow.FirstSeen.Ticks % TimeSpan.TicksPerSecond != 0),
            "a time with a fraction of a second survives being rewritten as ticks");
        var precise = carried.Select(flow => flow.FirstSeen.Ticks % TimeSpan.TicksPerSecond).ToArray();
        Assert(precise.Contains(1234567L),
            $"and survives exactly, to the hundred nanosecond: {string.Join(",", precise)}");
        // The whole seconds as well. Checking only the fraction lets a
        // conversion that mangles everything above the decimal point through:
        // the rows would come back in the year 1 with their fractions intact.
        Assert(carried.Any(flow => flow.FirstSeen == new DateTimeOffset(2020, 1, 1, 0, 0, 0, TimeSpan.Zero).AddTicks(1234567)),
            $"and at the instant it was recorded, not only the fraction of it: {carried.Min(flow => flow.FirstSeen):O}");
    }
    var migrationBackups = Directory.GetFiles(directory, "legacy-v1.db.pre-v*.bak");
    Assert(migrationBackups.Length == 1 && migrationBackups.Single().EndsWith("pre-v29.bak", StringComparison.Ordinal),
        "migration retains only the newest consistent backup generation");
    using (var migratedAgain = new ObservationStore(legacyDatabase))
        Assert(migratedAgain.SchemaVersion == 29, "migration is idempotent on restart");

    // The backup that survives a migration is the one whose migration
    // succeeded, and nothing used to delete it. It is the size of the
    // database, so keeping it forever doubles what the Agent occupies.
    using (var proving = new ObservationStore(legacyDatabase))
    {
        var backup = migrationBackups.Single();
        var backupBytes = new FileInfo(backup).Length;
        var takenAt = DateTimeOffset.UtcNow;
        File.SetLastWriteTimeUtc(backup, takenAt.UtcDateTime);

        Assert(proving.PruneProvenMigrationBackups(takenAt.AddHours(23)) == 0 && File.Exists(backup),
            "a migration backup is kept while the migration it protects is still being proven");

        // The window is the point: a backup deleted the moment the migration
        // commits is not an escape hatch, it is a copy made and thrown away.
        Assert(proving.PruneProvenMigrationBackups(takenAt.AddHours(24).AddSeconds(1)) == backupBytes,
            "a proven migration backup is deleted and reports the disk it returned");
        Assert(!File.Exists(backup), "the proven backup is gone from disk");
        Assert(proving.PruneProvenMigrationBackups(takenAt.AddDays(7)) == 0,
            "a second pass over an already-pruned directory frees nothing");

        // The prune walks a directory the operator can also put files in.
        var foreign = Path.Combine(directory, "legacy-v1.db.operator-copy.bak");
        var notOurs = Path.Combine(directory, "legacy-v1.db.pre-vX.bak");
        File.WriteAllBytes(foreign, new byte[11]);
        File.WriteAllBytes(notOurs, new byte[13]);
        File.SetLastWriteTimeUtc(foreign, takenAt.AddYears(-1).UtcDateTime);
        File.SetLastWriteTimeUtc(notOurs, takenAt.AddYears(-1).UtcDateTime);
        Assert(proving.PruneProvenMigrationBackups(takenAt.AddDays(7)) == 0
               && File.Exists(foreign) && File.Exists(notOurs),
            "only the Agent's own pre-v<number>.bak naming is deleted, however old the rest is");
        File.Delete(foreign);
        File.Delete(notOurs);

        // Disk usage counts the backup, so the number the user reads must
        // fall by exactly what was reclaimed.
        var withBackup = Path.Combine(directory, "legacy-v1.db.pre-v24.bak");
        File.WriteAllBytes(withBackup, new byte[4096]);
        File.SetLastWriteTimeUtc(withBackup, takenAt.AddYears(-1).UtcDateTime);
        var before = proving.ReadStorageBytes();
        Assert(proving.PruneProvenMigrationBackups(takenAt) == 4096,
            "an older generation left behind by a previous build is reclaimed too");
        Assert(proving.ReadStorageBytes() == before - 4096,
            "reported disk usage falls by what the prune returned");
    }

    var retentionDatabase = Path.Combine(directory, "retention.db");
    using (var retentionStore = new ObservationStore(retentionDatabase))
    {
        var now = new DateTimeOffset(2026, 9, 6, 12, 0, 0, TimeSpan.Zero);
        retentionStore.WriteBatch([
            new NetworkObservation(now.AddDays(-15), 1, "TCP", "10.0.0.1", 40001, "203.0.113.1", 443, 1, 1, ObservationLayer.Logical, null, "etw", "OldRaw"),
            new NetworkObservation(now.AddDays(-13), 2, "TCP", "10.0.0.1", 40002, "203.0.113.2", 443, 1, 1, ObservationLayer.Logical, null, "etw", "FreshRaw"),
            new NetworkObservation(now.AddDays(-31), 3, "TCP", "10.0.0.1", 40003, "203.0.113.3", 443, 1, 1, ObservationLayer.Logical, null, "etw", "OldAggregate")
        ]);
        // Bounded passes, run to completion: a single call folds only a few
        // hours, and retention below deletes raw observations old enough to
        // go. An hour pruned before it was summarised is gone for good.
        while (retentionStore.PendingChartFoldHours(now) > 0) retentionStore.FoldCompletedHoursForCharts(now);
        var oldCoverage = retentionStore.BeginCoverage([], now.AddDays(-31));
        retentionStore.EndCoverage(oldCoverage, now.AddDays(-31).AddMinutes(1));
        retentionStore.BeginSleepPeriod(now.AddDays(-31));
        retentionStore.EndSleepPeriod(now.AddDays(-31).AddMinutes(1));
        var result = retentionStore.PruneRetentionBatch(now, batchSize: 1);
        // Two chart rows for one aged-out hour: the per-application summary
        // and the per-destination one, which are pruned together because a
        // period that kept one without the other would disagree with itself.
        Assert(result.ObservationsDeleted == 1 && result.FlowsDeleted == 1 && result.HourlySummariesDeleted == 1 && result.CoverageSessionsDeleted == 1 && result.ChartSummariesDeleted == 2 && result.SleepPeriodsDeleted == 1,
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

        // The loop that empties the backlog, and the flag that drives it.
        //
        // A batch is bounded so it cannot hold the write lock for long -- one
        // of 50,000 measured at 65ms against a 4.6 GiB database, while the
        // service yields 100ms between batches and the collector buffers a
        // whole second. What makes that safe rather than merely slow is the
        // loop running until there is nothing left.
        //
        // MayHaveMore is what ends it, and nothing tested it. Had it always
        // said false, retention would delete one batch a day against nearly a
        // million rows written, and the database would grow for ever while
        // every assertion above still passed.
        var backlog = new List<NetworkObservation>();
        for (var index = 0; index < 25; index++)
            backlog.Add(new NetworkObservation(now.AddDays(-20).AddSeconds(index), 5, "TCP", "10.0.0.1",
                41000 + index, "203.0.113.9", 443, 1, 1, ObservationLayer.Logical, null, "etw", "Backlog"));
        retentionStore.WriteBatch(backlog);
        var dueBefore = retentionStore.Inspect().Count;

        var passes = 0; var sawMore = false; RetentionMaintenanceResult batch;
        do
        {
            batch = retentionStore.PruneRetentionBatch(now, batchSize: 10);
            sawMore |= batch.MayHaveMore(10);
            passes++;
        }
        while (batch.MayHaveMore(10) && passes < 50);

        Assert(sawMore, "a backlog larger than one batch says there is more to do");
        Assert(passes is > 1 and < 50, $"and the loop ends on its own, after {passes} passes");
        Assert(retentionStore.Inspect().Count < dueBefore,
            "having actually removed what was due, not just reported on it");
        Assert(retentionStore.PruneRetentionBatch(now, batchSize: 10).ObservationsDeleted == 0,
            "and a pass over a drained backlog finds nothing");
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
        // Ten minutes past the hour, because an hour is left to settle before
        // it is folded: an observation arriving after its hour was summarised
        // would belong to a summarised hour, and a summarised hour is not read
        // raw, so it would be counted nowhere at all.
        var settled = from.AddHours(3).AddMinutes(10);
        Assert(timelineStore.FoldCompletedHoursForCharts(settled) == 2 &&
            timelineStore.FoldCompletedHoursForCharts(settled) == 0,
            "completed chart hours fold once and the watermark makes the operation idempotent");
        var timeline = timelineStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(timeline.Connections == 1 && timeline.Timeline.Sum(item => item.Connections) == 2 &&
            timeline.Timeline.Select(item => item.Bucket).ToHashSet().SetEquals([0, 2]),
            "timeline uses each observation time instead of moving one long-lived flow into its last-seen bucket");

        // The same correction applied to the numbers above the chart, which had
        // it wrong in a way the chart did not. A flow row carries its whole
        // life's byte total, so summing the flows that overlap a period charged
        // the period for traffic that moved outside it. This flow lived from
        // +10m to +2h10m and moved 30 bytes in its first hour and 70 in its
        // third; the old total reported all 100 in each of them, and 100 again
        // in the hour between, when it moved nothing at all.
        var firstHour = timelineStore.ReadPeriodAnalysis(from, from.AddHours(1));
        Assert(firstHour.Connections == 1 && firstHour.Bytes == 30 &&
            firstHour.BytesSent == 10 && firstHour.BytesReceived == 20,
            "a period reports the bytes that moved inside it, not the whole life of every flow overlapping it");
        var quietHour = timelineStore.ReadPeriodAnalysis(from.AddHours(1), from.AddHours(2));
        Assert(quietHour.Connections == 1 && quietHour.Bytes == 0,
            "an hour in which an open flow moved nothing reports that nothing moved");
        var thirdHour = timelineStore.ReadPeriodAnalysis(from.AddHours(2), from.AddHours(3));
        Assert(thirdHour.Bytes == 70 && thirdHour.Links.Single().Bytes == 70,
            "per-destination bytes are cut to the period as well, so the chart and its rows agree");
        var wholePeriod = timelineStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(wholePeriod.Bytes == 100 && wholePeriod.Links.Sum(link => link.Bytes) == 100,
            "the periods still add up to everything the flow actually moved");
        timelineStore.WriteBatch([
            new NetworkObservation(from.AddHours(3).AddMinutes(10), 43, "UDP", "10.0.0.1", 51001,
                "198.51.100.43", 443, null, null, ObservationLayer.Logical, null, "etw", "CurrentHour")
        ]);
        timeline = timelineStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(timeline.Timeline.Sum(item => item.Connections) == 3 && timeline.Timeline.Any(item => item.Bucket == 3),
            "timeline combines folded complete hours with the current raw hour without gaps or duplicates");
    }

        // A period that starts mid-hour still counts the part-hour it starts in.
    //
    // The folded hours are whole hours inside the period, so a period starting
    // at half past has a leading stretch that only the raw observations can
    // answer for, and a trailing one for the hours not folded yet. Asked for
    // as one range with a hole in it, the index serves the outer range and the
    // hole becomes a filter over every row inside it: measured on a month,
    // 2.67 seconds to find 27,000 rows among 34 million, against 0.02 for the
    // two ranges named separately. Every fixture above starts on the hour, so
    // the leading range was never exercised and could have been dropped
    // entirely without a test noticing.
    using (var partialStore = new ObservationStore(Path.Combine(directory, "partial-hours.db")))
    {
        var hour = new DateTimeOffset(2026, 9, 24, 0, 0, 0, TimeSpan.Zero);
        NetworkObservation At(DateTimeOffset when, long sent) =>
            new(when, 77, "TCP", "10.0.0.1", 50003, "203.0.113.50", 443, sent, 0,
                ObservationLayer.Logical, null, "etw", "Straddler");
        partialStore.WriteBatch([
            At(hour.AddMinutes(40), 1),        // before the first whole hour
            At(hour.AddHours(1).AddMinutes(30), 10),
            At(hour.AddHours(2).AddMinutes(30), 100),
            At(hour.AddHours(3).AddMinutes(2), 1000),   // after the fold reaches
        ]);
        while (partialStore.PendingChartFoldHours(hour.AddHours(3).AddMinutes(10)) > 0)
            partialStore.FoldCompletedHoursForCharts(hour.AddHours(3).AddMinutes(10));

        var period = partialStore.ReadPeriodAnalysis(hour.AddMinutes(30), hour.AddHours(3).AddMinutes(5));
        Assert(period.Bytes == 1111,
            "a period starting mid-hour counts the part-hour before the folded hours, and the part-hour after them");
        Assert(period.Links.Single().Bytes == 1111,
            "and its destinations are made of the same three stretches");
    }

    // Per-destination bytes come from an aggregate, not from a day of rows.
    //
    // The links query had no aggregate to read, so a period scanned every raw
    // observation in it. Measured on one machine, a day held 6,500,653 of them
    // and that one query took 5.33 seconds, on the single pipe the window also
    // asks "is the agent running".
    using (var destStore = new ObservationStore(Path.Combine(directory, "hourly-destinations.db")))
    {
        var from = new DateTimeOffset(2026, 9, 23, 0, 0, 0, TimeSpan.Zero);
        NetworkObservation To(string address, int hour, int minute, long sent, long received, string? name = null) =>
            new(from.AddHours(hour).AddMinutes(minute), 31, "TCP", "10.0.0.1", 50000 + minute, address, 443,
                sent, received, ObservationLayer.Logical, null, "etw", "Talker", name);
        destStore.WriteBatch([
            To("203.0.113.40", 0, 5, 10, 20, "one.example"),
            To("203.0.113.40", 0, 6, 1, 2),
            To("203.0.113.41", 0, 7, 100, 200, "two.example"),
            To("203.0.113.40", 1, 5, 1000, 2000),
        ]);
        while (destStore.PendingChartFoldHours(from.AddHours(3)) > 0)
            destStore.FoldCompletedHoursForCharts(from.AddHours(3));

        var period = destStore.ReadPeriodAnalysis(from, from.AddHours(24), bucketCount: 60);
        var first = period.Links.Single(link => link.Destination == "203.0.113.40");
        Assert(first.Bytes == 3033 && period.Links.Single(link => link.Destination == "203.0.113.41").Bytes == 300,
            "a destination's bytes survive being summarised, hour by hour, and add back up");
        Assert(first.DestinationName == "one.example",
            "and the name it answered to is kept with them");
        Assert(period.Links.Sum(link => link.Bytes) == period.Bytes,
            "the destinations and the period total tell the same story");

        // The hour still being written has no folded row, and must be read raw
        // rather than left out.
        destStore.WriteBatch([To("203.0.113.42", 2, 30, 7, 8)]);
        var withCurrent = destStore.ReadPeriodAnalysis(from, from.AddHours(3), bucketCount: 60);
        Assert(withCurrent.Links.Single(link => link.Destination == "203.0.113.42").Bytes == 15,
            "the hour still in progress is read from the observations, so nothing is missing from the end");
    }

    // Every period keeps the bucket count it asked for.
    //
    // An hourly row cannot be cut into a bucket shorter than an hour, so a
    // period whose buckets are narrower than that reads the raw rows for the
    // whole of itself -- which is what the Mac Agent does, and what makes the
    // two charts comparable. Widening a day's buckets to an hour was tried and
    // taken out again: it made a day's bars two and a half times wider than
    // every other period's, and the bar width is how a reader tells one chart
    // from another.
    using (var wideStore = new ObservationStore(Path.Combine(directory, "hourly-buckets.db")))
    {
        var from = new DateTimeOffset(2026, 9, 22, 0, 0, 0, TimeSpan.Zero);
        var rows = new List<NetworkObservation>();
        for (var hour = 0; hour < 20; hour++)
            rows.Add(new NetworkObservation(from.AddHours(hour).AddMinutes(5), 12, "TCP", "10.0.0.1", 50000 + hour,
                "203.0.113.30", 443, 100, 200, ObservationLayer.Logical, null, "etw", "Wide"));
        wideStore.WriteBatch(rows);
        Assert(wideStore.FoldCompletedHoursForCharts(from.AddHours(21)) > 0, "the hours fold");

        var day = wideStore.ReadPeriodAnalysis(from, from.AddHours(24), bucketCount: 60);
        Assert(day.Timeline.Select(item => item.Bucket).Distinct().Count() == 20 &&
            day.Timeline.Select(item => item.Bucket).Max() < 60,
            "a day keeps sixty buckets and reads them from the raw rows");
        // Each hour's traffic in its own bar. julianday returns a fractional
        // day that cannot hold an exact hour: 04:00 came back as 14,399.999987
        // seconds after midnight, which truncates into the bucket before it,
        // and every bar landed one place to the left of its traffic. With
        // twenty-four minute buckets an hour falls every 2.5 buckets, so the
        // hours land on 0, 2, 5, 7, 10 and so on.
        Assert(day.Timeline.Select(item => item.Bucket).OrderBy(bucket => bucket)
                .SequenceEqual(Enumerable.Range(0, 20).Select(hour => hour * 60 / 24)),
            "and each hour lands in the bar its traffic happened in");
        Assert(day.Timeline.Sum(item => item.Connections) == 20 && day.Timeline.Sum(item => item.Bytes) == 6000,
            "and every hour's traffic is still counted exactly once");

        // Short enough to read raw, where the finer resolution is worth having
        // and costs little.
        var sixHours = wideStore.ReadPeriodAnalysis(from, from.AddHours(6), bucketCount: 60);
        Assert(sixHours.Timeline.Select(item => item.Bucket).Max() > 23,
            "and a shorter period spreads its traffic across the same sixty");

        // How many bars the chart has to draw, said rather than inferred.
        //
        // The drawing took the highest bucket it had been given and floored it
        // at sixty, which was right only while every period asked for sixty.
        // Once a day was drawn in twenty-four hourly bars, twenty-four bars
        // were laid across sixty bars' worth of width and the right-hand 60%
        // of the card was empty -- with the traffic in the database the whole
        // time. Nothing could have caught that from the timeline rows alone,
        // because those rows were right.
        Assert(day.BucketCount == 60 && sixHours.BucketCount == 60,
            "a period reports how many buckets it was divided into, so the drawing need not guess");
    }

    // The chart counts connections, because that is what its legend says.
    //
    // It plotted observation_count. While the collector wrote a row per packet
    // those were nowhere near each other: measured on one machine, a single
    // minute held 310,764 rows and 215 connections, and the chart drew the
    // first -- a bar 1,445 times the truth, flattening every other hour on the
    // screen, while the summary directly above it read 2,647 connections for
    // the same period. The summing in the collector narrows the gap and does
    // not close it: a row is now a flow-second, and a connection open for a
    // minute is still sixty of them.
    using (var chartStore = new ObservationStore(Path.Combine(directory, "chart-counts-connections.db")))
    {
        var from = new DateTimeOffset(2026, 9, 21, 0, 0, 0, TimeSpan.Zero);
        NetworkObservation Row(int seconds, int port, long sent) =>
            new(from.AddSeconds(seconds), 7, "TCP", "10.0.0.1", port, "203.0.113.7", 443, sent, 0,
                ObservationLayer.Logical, null, "etw", "Chatty");
        // Two connections, seven rows: five seconds of one, two of the other.
        chartStore.WriteBatch([
            Row(1, 40001, 1), Row(2, 40001, 1), Row(3, 40001, 1), Row(4, 40001, 1), Row(5, 40001, 1),
            Row(6, 40002, 1), Row(7, 40002, 1),
        ]);

        // Raw hour: buckets narrower than an hour read the observations.
        var raw = chartStore.ReadPeriodAnalysis(from, from.AddHours(1), bucketCount: 12);
        Assert(raw.Timeline.Sum(item => item.Connections) == 2 && raw.Connections == 2,
            "the chart and the summary above it agree on how many connections a period held");

        // Folded hour: the same answer has to survive being summarised.
        Assert(chartStore.FoldCompletedHoursForCharts(from.AddHours(2)) > 0, "the hour folds");
        var folded = chartStore.ReadPeriodAnalysis(from, from.AddHours(12), bucketCount: 12);
        Assert(folded.Timeline.Sum(item => item.Connections) == 2,
            "a folded hour remembers its connections rather than its rows");
        Assert(folded.Timeline.Sum(item => item.Bytes) == 7,
            "and still remembers every byte those rows carried");

        // UDP identity includes its peer. The startup table cannot supply one,
        // so those entries are coverage placeholders rather than flows.
        chartStore.WriteBatch([
            new NetworkObservation(from.AddHours(2).AddMinutes(1), 8, "UDP", "10.0.0.1", 5353,
                "203.0.113.8", 5353, 1, 0, ObservationLayer.Logical, null, "etw", "Responder"),
            new NetworkObservation(from.AddHours(2).AddMinutes(2), 8, "UDP", "10.0.0.1", 5353,
                "203.0.113.9", 5353, 1, 0, ObservationLayer.Logical, null, "etw", "Responder"),
        ]);
        var udp = chartStore.ReadPeriodAnalysis(from.AddHours(2), from.AddHours(3), bucketCount: 12);
        Assert(udp.Connections == 2 && udp.Timeline.Sum(item => item.Connections) == 2,
            "two UDP peers are two connections in both the summary and the chart");
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

    // A flow's times must come out in order however its observations arrive.
    //
    // Both upserts assigned the last time from whichever observation arrived
    // most recently, which is only right if they arrive in time order. They do
    // not: ETW callbacks are not strictly ordered, and the per-second summing
    // emits a bucket when the event timeline passes it rather than when its
    // own traffic happened. The Hub checks first <= last and answers 400 for
    // the whole batch. Measured here: 31 of 10,000 queued observations were
    // inverted -- about one in three hundred, enough that half of all
    // 200-observation batches carried one and every one of those was refused.
    using (var orderStore = new ObservationStore(Path.Combine(directory, "out-of-order.db")))
    {
        var late = new DateTimeOffset(2026, 9, 21, 10, 0, 1, TimeSpan.Zero);
        var early = late.AddMilliseconds(-420);
        NetworkObservation At(DateTimeOffset when, long sent) =>
            new(when, 64, "TCP", "10.0.0.1", 50002, "203.0.113.12", 443, sent, 0,
                ObservationLayer.Logical, "if", "etw", "OutOfOrder");

        // The later time first, the earlier one second: the order the Agent
        // actually sees them in when a bucket closes late.
        orderStore.WriteBatch([At(late, 1)]);
        orderStore.WriteBatch([At(early, 2)]);
        orderStore.QueueForDelivery([At(late, 1)], late);
        orderStore.QueueForDelivery([At(early, 2)], late);

        var flow = orderStore.ReadRecentFlows(50).Single(item => item.ProcessName == "OutOfOrder");
        Assert(flow.FirstSeen == early && flow.LastSeen == late,
            "a flow keeps the earliest and the latest time, not the times of the last observation to arrive");

        var queued = orderStore.PrepareDeliveryBatch(late.AddSeconds(1))!.Observations.Single();
        Assert(queued.FirstObservedAt <= queued.LastObservedAt && queued.FirstObservedAt == early && queued.LastObservedAt == late,
            "and so does the observation queued for the Hub, which refuses the whole batch over one inverted pair");
    }

    // A batch the Hub will never accept must not stop the ones behind it,
    // and must not take them with it either.
    //
    // Preparing a batch reuses any that is still outstanding, which is what
    // keeps an interrupted send from orphaning data. It also means a refusal
    // that will repeat blocks the queue for ever. Measured on a real machine:
    // one batch of 107 observations claimed at 01:34:33Z was still claimed
    // three hours later, the queue behind it sat at its 10,000 ceiling, and
    // 17,813 observations had been dropped to make room for arrivals.
    //
    // Discarding the refused batch was the first answer and was too blunt: it
    // unblocked delivery and then shed 200 observations every two and a half
    // minutes, because one record the Hub would not take condemned the 199
    // travelling with it. Halving finds the one.
    using (var poisonStore = new ObservationStore(Path.Combine(directory, "poison-batch.db")))
    {
        NetworkObservation Refused(int port) =>
            new(deliveryStarted.AddSeconds(port), 91, "TCP", "10.0.0.1", 50000 + port, "203.0.113.11", port,
                10, 20, ObservationLayer.Logical, "if", "etw", "Refused");
        for (var port = 1; port <= 8; port++)
            poisonStore.QueueForDelivery([Refused(port)], deliveryStarted.AddSeconds(port));
        Assert(poisonStore.ReadDeliveryStatus().Pending == 8, "eight distinct flows queue as eight observations");

        var batch = poisonStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(20))!;
        Assert(batch.Observations.Count == 8, "and are claimed as one batch");

        // Halving, not discarding. Every refusal hands the younger half back
        // to the queue and carries on with the older one.
        foreach (var remaining in new[] { 4, 2, 1 })
        {
            Assert(poisonStore.RecordDeliveryBatchRejection(batch.BatchId) == DeliveryRefusal.Split,
                $"a refused batch of more than one is halved, leaving {remaining}");
            var carried = poisonStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(21))!;
            Assert(carried.BatchId == batch.BatchId && carried.Observations.Count == remaining,
                $"the batch carries on with {remaining} observation(s) under the same id");
            Assert(poisonStore.ReadDeliveryStatus().Pending == 8,
                "and nothing has been lost: the released half is back in the queue");
        }

        // Down to one, the refusal is about that observation and nothing else.
        // Still not thrown away on the first answer -- a Hub mid-deploy says
        // "rejected" too.
        for (var attempt = 1; attempt < ObservationStore.AbandonBatchAfterRejections; attempt++)
            Assert(poisonStore.RecordDeliveryBatchRejection(batch.BatchId) == DeliveryRefusal.Retained &&
                poisonStore.ReadDeliveryStatus().Pending == 8,
                $"a single refused observation is kept on attempt {attempt}");

        Assert(poisonStore.RecordDeliveryBatchRejection(batch.BatchId) == DeliveryRefusal.Abandoned,
            "and is given up on once the refusals have been answered enough times");
        Assert(poisonStore.ReadDeliveryStatus().Pending == 7,
            "exactly one observation is lost, not the batch it arrived in");
        Assert(poisonStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(40))!.Observations.Count == 7,
            "and the other seven are claimable again");

        var counters = poisonStore.ReadCounters();
        Assert(counters.TryGetValue("delivery-batches-split", out var splits) && splits == 3 &&
            counters.TryGetValue("delivery-observations-abandoned", out var lost) && lost == 1,
            "the halvings and the single loss are both counted, because a loss nobody can count is the failure that started this");

        // A transport failure says nothing about the batch. An Agent offline
        // for an afternoon has to come back with its queue intact, so those
        // failures must not halve it or spend its lives.
        var offline = poisonStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(41))!;
        for (var attempt = 0; attempt < ObservationStore.AbandonBatchAfterRejections * 3; attempt++)
            Assert(poisonStore.PrepareDeliveryBatch(deliveryStarted.AddSeconds(42 + attempt))!.BatchId == offline.BatchId,
                "a batch nobody has refused is still whole after any number of transport failures");
        Assert(poisonStore.ReadDeliveryStatus().Pending == 7, "and still holds every observation");

        // The tally is kept against the batch's own id, so an acknowledgement
        // cannot leave it charged to the next batch: batch ids are fresh
        // GUIDs, and a different id restarts the count on its own. The reset
        // in AcknowledgeDelivery is belt-and-braces, and is deliberately not
        // asserted here -- a test of it could not fail, and a green light that
        // cannot go red is worse than no light.
        poisonStore.AcknowledgeDelivery(offline.BatchId, deliveryStarted.AddSeconds(90));
        Assert(poisonStore.ReadDeliveryStatus().Pending == 0,
            "an acknowledged batch leaves the queue however many transport failures preceded it");

        // A refusal that arrives after the batch has gone is late, not wrong.
        Assert(poisonStore.RecordDeliveryBatchRejection(offline.BatchId) == DeliveryRefusal.Unknown,
            "and a refusal naming a batch that no longer exists changes nothing");
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

    // A refusal that halved the batch must not be answered with a longer wait.
    //
    // The controller backs off on every refusal, which is right for a server in
    // trouble and wrong for one that answered. Measured before the two were
    // separated: an eight-step bisection ran at the 300-second retry ceiling,
    // and the queue reached its own 10,000 ceiling and began dropping at the
    // far end while it waited -- trading the loss the halving had just
    // prevented for a different one. The sender says which refusals changed the
    // payload so the controller can tell the two apart.
    using (var narrowStore = new ObservationStore(Path.Combine(directory, "narrowing.db")))
    {
        for (var port = 1; port <= 4; port++)
            narrowStore.QueueForDelivery([new NetworkObservation(deliveryStarted.AddSeconds(port), 88, "UDP",
                "10.0.0.1", 53000 + port, "203.0.113.9", port, 42, 24, ObservationLayer.Logical, "if", "etw", "Browser")],
                deliveryStarted.AddSeconds(port));
        var refusing = new DeliveryHandler(400, 400, 400, 400, 400, 400, 400, 400);
        var narrowSender = new DeliverySender(new HttpClient(refusing));
        var narrowCredential = new AgentCredential(new Uri("https://hub.example/"), agentId, agentToken, deliveryStarted);
        var narrowMetadata = new DeliveryMetadata("host", "windows", "Windows", "dev");

        foreach (var remaining in new[] { 2, 1 })
        {
            var narrowed = await narrowSender.SendNextAsync(narrowStore, narrowCredential, narrowMetadata);
            Assert(narrowed.Kind == DeliveryAttemptKind.Rejected && narrowed.Narrowed,
                $"a refusal that halves the batch says so, leaving {remaining}");
        }
        var single = await narrowSender.SendNextAsync(narrowStore, narrowCredential, narrowMetadata);
        Assert(single.Kind == DeliveryAttemptKind.Rejected && !single.Narrowed,
            "and a refusal of a single observation does not, because waiting is then the right answer");
        Assert(narrowStore.ReadDeliveryStatus().Pending == 4,
            "nothing has been given up on while the refusal is still being narrowed");
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
            // The list used to be on the download page. It moved to the privacy
            // note, which is where the page and the footer now point and where
            // someone auditing would look; the page reads better without a
            // column of JSON keys in it. What must not change is that every key
            // the sender actually serialises is disclosed somewhere a reader
            // can reach, which is what this has always checked.
            foreach (var note in new[] { "agent-privacy-windows.md", "agent-privacy-windows.ja.md" })
            {
                var text = File.ReadAllText(Path.Combine(windowsRoot, "..", "..", "docs", note));
                Assert(sentKeys.All(key => text.Contains($"`{key}`", StringComparison.Ordinal)),
                    $"docs/{note} lists every key in the sent JSON payload");
            }
            Assert(!sentKeys.Contains("schemaVersion") || !downloadPage.Contains("schemaVersion", StringComparison.Ordinal),
                "and the download page no longer carries the list, so the two cannot drift apart");
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

        // Network ETW is a packet stream. Crossing into the process API for
        // every packet made the callback run ten times behind wall clock on a
        // real machine and overflowed millions of ETW events. The lifecycle
        // provider updates this cache immediately; the live probe is only a
        // bounded fallback when that provider misses an event.
        var probeNow = now;
        var probeCalls = 0;
        var cachedResolver = new ProcessNameResolver(
            TimeSpan.FromMinutes(2),
            _ => { probeCalls++; return new ProcessNameResolver.LiveProcess("browser", started); },
            clock: () => probeNow);
        for (var packet = 0; packet < 10_000; packet++)
            Assert(cachedResolver.Resolve(4343, now.AddTicks(packet)) == "browser",
                "a packet keeps the process name supplied by the bounded cache");
        Assert(probeCalls == 1 && cachedResolver.CacheHits == 9_999,
            "ten thousand packets in one probe interval cross into Windows once, not ten thousand times");
        probeNow = probeNow.Add(ProcessNameResolver.LiveProbeInterval).AddMilliseconds(1);
        Assert(cachedResolver.Resolve(4343, now.AddSeconds(1)) == "browser" && probeCalls == 2,
            "the live fallback checks the PID again after the bounded interval");

        // If that fallback discovers a reused PID while old ETW callbacks are
        // still draining, the old event keeps the old owner and the next
        // current event gets the new one.
        var owner = new ProcessNameResolver.LiveProcess("first", started);
        probeNow = now;
        var backlogResolver = new ProcessNameResolver(TimeSpan.FromMinutes(2), _ => owner, clock: () => probeNow);
        Assert(backlogResolver.Resolve(4444, now) == "first", "the original PID owner is cached");
        owner = new ProcessNameResolver.LiveProcess("second", now.AddSeconds(1));
        probeNow = probeNow.AddSeconds(2);
        var oldIdentity = backlogResolver.ResolveIdentity(4444, now.AddMilliseconds(500));
        Assert(oldIdentity.Name == "first",
            "a delayed event is not relabelled with the PID's new owner");
        var newIdentity = backlogResolver.ResolveIdentity(4444, now.AddSeconds(2));
        Assert(newIdentity.Name == "second",
            "after reuse, current traffic takes the new owner from the in-memory cache");
        Assert(oldIdentity.InstanceId != newIdentity.InstanceId && oldIdentity.Name == "first" && newIdentity.Name == "second",
            "PID reuse produces distinct process-instance identities while delayed events retain their owner");

        var unreadable = new ProcessNameResolver(TimeSpan.FromMinutes(2),
            _ => new ProcessNameResolver.LiveProcess("protected", null));
        var unreadableFirst = unreadable.ResolveIdentity(4555, now);
        unreadable.BeginProcessInstance(4555);
        var unreadableSecond = unreadable.ResolveIdentity(4555, now.AddSeconds(1));
        Assert(unreadableFirst.InstanceId != unreadableSecond.InstanceId &&
               unreadableFirst.InstanceId.StartsWith("session:", StringComparison.Ordinal),
            "an unreadable start time fails closed to a collector-session generation rather than merging owners");

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

    // A start that dies before it can open a run (P3-133). On 2026-09-18 an
    // upgraded service lived ten seconds; Windows logged it and the Agent's
    // history went from the old version's clean stop straight to the restart,
    // as if nothing had happened in between. run_history is in the database,
    // and that start never got the database open.
    {
        var startsData = Path.Combine(directory, "starts-service");
        Directory.CreateDirectory(startsData);
        var startsDb = Path.Combine(startsData, "egressview-agent.db");
        var t0 = new DateTimeOffset(2026, 9, 18, 14, 8, 24, TimeSpan.Zero);

        // A: reaches the database, opens a run, and is killed while running.
        var startA = ServiceStarts.Record(startsData, "0.1.52", t0);
        using (var a = new ObservationStore(startsDb))
        {
            a.RecordUnreachedStarts(ServiceStarts.Read(startsData).Where(start => start.Token != startA.Token));
            a.BeginRun(RunComponent.Service, "0.1.52", startA.At);
            ServiceStarts.Clear(startsData);
        }
        // B: the upgraded service, dead ten seconds in, before the database.
        var startB = ServiceStarts.Record(startsData, "0.1.53", t0.AddSeconds(19));
        // C: the restart a minute later, which gets through.
        var startC = ServiceStarts.Record(startsData, "0.1.53", t0.AddSeconds(104));
        Assert(ServiceStarts.Read(startsData).Select(start => start.Token).SequenceEqual(new[] { startB.Token, startC.Token }),
            "the starts are on record before any database is opened");

        using (var c = new ObservationStore(startsDb))
        {
            var filed = c.RecordUnreachedStarts(ServiceStarts.Read(startsData).Where(start => start.Token != startC.Token));
            var runC = c.BeginRun(RunComponent.Service, "0.1.53", startC.At);
            ServiceStarts.Clear(startsData);
            Assert(filed == 1, $"one start never reached the database, not {filed}");

            var history = c.ReadRunHistory(10).Where(run => run.Component == RunComponent.Service).ToArray();
            // Newest first: C running, B that never got anywhere, A killed.
            Assert(history.Length == 3, $"three service runs, not {history.Length}");
            Assert(history[0].Version == "0.1.53" && history[0].Ending == "running" && history[0].StartedAt == startC.At,
                "this run began when its process did, not after the database opened");
            Assert(history[1].Version == "0.1.53" && history[1].Ending == "unexpected"
                   && history[1].Fault == ServiceStarts.StoppedBeforeRecording
                   && history[1].StartedAt == startB.At && history[1].EndedAt == startB.At,
                $"the start that died early is there, as unexpected and before recording, not {history[1]}");
            // Nothing is known about how long it lived, so nothing is claimed.
            Assert(history[1].HeartbeatAt is null, "and it claims no time it did not report");
            Assert(history[2].Version == "0.1.52" && history[2].Ending == "unexpected" && history[2].Fault is null,
                "and the run that was killed while running is told apart from it");

            // Filed once. A start that reached BeginRun but died before the
            // file was cleared is recognised by its start time.
            var again = c.RecordUnreachedStarts([startB, startC]);
            Assert(again == 0, $"nothing already on record is filed twice, not {again}");

            // And the diagnostics count it apart.
            var report = DiagnosticsReport.Create(new CollectorSnapshot("running", 0, 0, 0, 0, null, null, 0), c, "0.1.53");
            using var document = System.Text.Json.JsonDocument.Parse(report);
            var summary = document.RootElement.GetProperty("runSummary").GetProperty("service");
            Assert(summary.GetProperty("stoppedBeforeRecording").GetInt32() == 1 && summary.GetProperty("unexpected").GetInt32() == 2,
                $"the summary counts the early death apart from the crash: {summary}");
            Assert(DiagnosticsBundle.RenderText(report).Contains("Service starts that stopped before recording: 1", StringComparison.Ordinal),
                "and diagnostics.txt says it in a line");
            c.EndRun(runC);
        }
        Assert(ServiceStarts.Read(startsData).Count == 0, "once filed, the file is emptied");

        // Bounded: a service that dies on every start does not grow the file
        // without end.
        for (var i = 0; i < ServiceStarts.Kept + 15; i++)
            ServiceStarts.Record(startsData, "0.1.53", t0.AddMinutes(i));
        var kept = ServiceStarts.Read(startsData);
        Assert(kept.Count == ServiceStarts.Kept && kept[^1].At == t0.AddMinutes(ServiceStarts.Kept + 14),
            $"only the last {ServiceStarts.Kept} starts are kept, newest last, not {kept.Count}");
        ServiceStarts.Clear(startsData);
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
            Assert(store.SchemaVersion >= 17, "the traffic-window table arrives with schema 17");
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
        // A country table on this PC, so the question never leaves it.
        //
        // The fixture is built from the published specification rather than
        // from the reader, so this checks the reader against the format and
        // not against a copy of itself.
        {
            var db = new MaxMindDatabase(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase());
            Assert(db.Metadata.NodeCount > 0 && db.Metadata.RecordSize == 24 &&
                db.Metadata.IpVersion == 4 && db.Metadata.DatabaseType == "GeoLite2-Country",
                "the file says what it is, and the reader believes the file rather than its own defaults");
            Assert(db.CountryCode("8.8.8.8") == "US" && db.CountryCode("1.2.3.4") == "JP" &&
                db.CountryCode("203.0.113.9") == "AU",
                "an address inside a listed prefix is placed in its country");
            Assert(db.CountryCode("9.9.9.9") is null && db.CountryCode("not an address") is null,
                "an address the table does not cover is answered with nothing, not with a guess");

            // The licence requires moving to a new build within thirty days,
            // so how old the copy is has to be answerable.
            var built = new MaxMindDatabase(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase(1_700_000_000));
            Assert(built.Metadata.BuiltAt == DateTimeOffset.FromUnixTimeSeconds(1_700_000_000) &&
                built.Metadata.Age(built.Metadata.BuiltAt.AddDays(31)).TotalDays > 30,
                "the table can say how old it is");

            AssertMaxMindFailure(() => new MaxMindDatabase("not a database"u8.ToArray()),
                MaxMindFailureKind.NoMetadata,
                "a file with no metadata marker is refused rather than read as an empty table");
        }

        // Fetching the country table with the reader's own MaxMind account.
        {
            // MaxMind hands out a filled-in GeoIP.conf when a key is created,
            // and shows the key exactly once. Retyping forty characters from a
            // page you cannot revisit is where this goes wrong, so the file is
            // what gets accepted.
            var conf = string.Join(Environment.NewLine,
                "# GeoIP.conf as the portal writes it",
                "AccountID 123456",
                "LicenseKey abcdefghijklmnop   # keep this secret",
                "EditionIDs GeoLite2-Country GeoLite2-City");
            var parsed = GeoLite2Credentials.FromConfiguration(conf);
            Assert(parsed is { AccountId: "123456", LicenseKey: "abcdefghijklmnop" },
                "the account and the key are read from the file, and the rest of it is not this Agent's business");
            Assert(GeoLite2Credentials.FromConfiguration("UserId 7" + Environment.NewLine + "LicenseKey k") is { AccountId: "7" },
                "the older UserId spelling is accepted too");
            Assert(GeoLite2Credentials.FromConfiguration("AccountID 123456") is null,
                "half a credential is refused rather than sent");

            var archive = BuildGeoArchive(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase());
            var ok = new GeoLite2Handler(HttpStatusCode.OK, archive);
            var fetched = await new GeoLite2Updater(new HttpClient(ok)).FetchAsync(parsed!);
            Assert(new MaxMindDatabase(fetched.Data).CountryCode("8.8.8.8") == "US" &&
                fetched.Metadata.DatabaseType == "GeoLite2-Country",
                "the database is pulled out of the archive and read before it is trusted");
            Assert(ok.Authorization is { Scheme: "Basic" } &&
                !(ok.RequestedUri?.Query.Contains("abcdefghijklmnop", StringComparison.Ordinal) ?? true),
                "the key travels in a header, never in a query string that ends up in logs");

            // MaxMind says why in one plain sentence. Throwing it away leaves
            // a reader unable to tell a mistyped key from an account without
            // access to this edition.
            var refusal = System.Text.Encoding.UTF8.GetBytes("Your account ID or license key could not be authenticated.");
            var denied = new GeoLite2Updater(new HttpClient(new GeoLite2Handler(HttpStatusCode.Unauthorized, refusal)));
            try
            {
                await denied.FetchAsync(parsed!);
                Assert(false, "a refused download does not come back as success");
            }
            catch (GeoLite2Exception exception)
            {
                Assert(exception.Kind == GeoLite2FailureKind.Unauthorised &&
                    exception.Reason.Contains("could not be authenticated", StringComparison.Ordinal),
                    "what MaxMind said is passed on rather than replaced with our own guess");
            }

            // A page of HTML is not an explanation.
            Assert(GeoLite2Updater.Reason("<html><body>Error</body></html>"u8.ToArray()).Length == 0,
                "an error page is not shown to anyone as a reason");

            var rubbish = new GeoLite2Updater(new HttpClient(new GeoLite2Handler(HttpStatusCode.OK,
                BuildGeoArchive("this is not a database"u8.ToArray()))));
            try
            {
                await rubbish.FetchAsync(parsed!);
                Assert(false, "a download that is not a database does not come back as success");
            }
            catch (GeoLite2Exception exception)
            {
                Assert(exception.Kind == GeoLite2FailureKind.NotADatabase,
                    "a file that does not read as a database never reaches where the working one is kept");
            }

            // Installing replaces in one step: a half-written file reads as
            // corrupt, and keeping the old table beats briefly having neither.
            var installed = Path.Combine(directory, "geo", "GeoLite2-Country.mmdb");
            GeoLite2Updater.Install(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase(1_700_000_000), installed);
            GeoLite2Updater.Install(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase(1_800_000_000), installed);
            Assert(MaxMindDatabase.Open(installed).Metadata.BuildEpoch == 1_800_000_000 &&
                Directory.GetFiles(Path.GetDirectoryName(installed)!).Length == 1,
                "the new table replaces the old one and leaves nothing half-written beside it");
        }

        // The table has an expiry, and it is not advisory.
        //
        // MaxMind's licence requires moving to a new build promptly and
        // destroying anything more than thirty days behind it. A copy that old
        // is not merely stale -- using it breaks the terms it came under -- so
        // it stops answering rather than quietly carrying on.
        {
            var tablePath = Path.Combine(directory, "country", "GeoLite2-Country.mmdb");
            var table = new LocalCountryTable(tablePath);
            Assert(table.Status(DateTimeOffset.UtcNow).State == LocalCountryTableState.Absent &&
                table.CountryCode("8.8.8.8", DateTimeOffset.UtcNow) is null,
                "no table means no answer, which is a state rather than a failure");

            var built = new DateTimeOffset(2026, 9, 1, 0, 0, 0, TimeSpan.Zero);
            GeoLite2Updater.Install(EgressView.Agent.Core.Tests.MaxMindFixture.CountryDatabase((ulong)built.ToUnixTimeSeconds()), tablePath);
            table.Reload();
            Assert(table.Status(built.AddDays(1)).IsUsable && table.CountryCode("8.8.8.8", built.AddDays(1)) == "US",
                "a fresh table answers");
            Assert(table.Status(built.AddDays(31)).State == LocalCountryTableState.Expired &&
                table.CountryCode("8.8.8.8", built.AddDays(31)) is null,
                "a table past the licence's thirty days stops answering, and says why it stopped");

            Assert(LocalCountryTable.Attribution.Contains("MaxMind", StringComparison.Ordinal),
                "the attribution the licence requires travels with the code that uses the data");
        }

        // Only addresses nobody has placed, so a Hub's richer answer is never
        // replaced by a country-only one.
        {
            var countryDatabase = Path.Combine(directory, "local-country.db");
            using var store = new ObservationStore(countryDatabase);
            Assert(store.SchemaVersion >= 18, "the local country cache arrives with schema 18");
            var now = DateTimeOffset.UtcNow;
            store.WriteBatch([
                new NetworkObservation(now.AddMinutes(-1), 21, "TCP", "10.0.0.3", 52_000, "8.8.8.8", 443,
                    10, 10, ObservationLayer.Logical, null, "etw", "resolver"),
                new NetworkObservation(now.AddMinutes(-1), 22, "TCP", "10.0.0.3", 52_001, "1.2.3.4", 443,
                    10, 10, ObservationLayer.Logical, null, "etw", "resolver"),
            ]);
            store.ReplaceGeoLocations([new GeoLocation("8.8.8.8", 37.4, -122.0, "US", "Mountain View")], null, now);

            var unplaced = store.ReadAddressesWithoutCountry(now.AddHours(-1));
            Assert(unplaced.Contains("1.2.3.4") && !unplaced.Contains("8.8.8.8"),
                "an address the Hub already placed is not asked about again");

            Assert(store.ReadLocalCountryCount() == 0, "nothing has been placed on this PC yet");
            store.SaveLocalCountries([("1.2.3.4", "JP")]);
            Assert(store.ReadLocalCountryCount() == 1,
                "the screen can say whether the table is doing anything, not only that it loaded");
            var countries = store.ReadCountryHistory().ToDictionary(row => row.CountryCode, row => row.Connections);
            Assert(countries.ContainsKey("JP") && countries.ContainsKey("US"),
                "a country worked out on this PC counts beside one the Hub supplied");
            Assert(store.ReadAddressesWithoutCountry(now.AddHours(-1)).Count == 0,
                "an address placed locally is not asked about again either");

            store.ForgetLocalCountries();
            Assert(!store.ReadCountryHistory().Any(row => row.CountryCode == "JP"),
                "withdrawing the table withdraws the answers that came from it");
            Assert(store.ReadLocalCountryCount() == 0, "and the count goes with them");
        }

        // Handing the account over, and taking it back.
        {
            string? received = "unset";
            var calls = 0;
            string Ask(string request) => IpcProtocol.Handle(request, () => "{}", _ => [],
                setCountryTableAccount: configuration =>
                {
                    received = configuration;
                    calls++;
                    return configuration is null || configuration.Contains("LicenseKey", StringComparison.Ordinal);
                });

            var conf = "# GeoIP.conf" + Environment.NewLine + "AccountID 123456" + Environment.NewLine +
                "LicenseKey abcdefghijklmnop" + Environment.NewLine + "EditionIDs GeoLite2-Country" + Environment.NewLine;
            var accepted = Ask(JsonSerializer.Serialize(new { v = 1, op = "set-country-table-account", configuration = conf }));
            Assert(accepted.Contains("\"status\":\"ok\"", StringComparison.Ordinal) && received == conf,
                "the file's own text reaches the service, which is the only thing that stores it");
            Assert(!accepted.Contains("abcdefghijklmnop", StringComparison.Ordinal),
                "the reply never repeats the licence key back");

            Assert(Ask(JsonSerializer.Serialize(new { v = 1, op = "set-country-table-account", configuration = "hello" }))
                .Contains("no-maxmind-account", StringComparison.Ordinal),
                "a file with no account is named as such, not reported as a connection problem");

            var cleared = Ask("""{"v":1,"op":"set-country-table-account"}""");
            Assert(cleared.Contains("\"configured\":false", StringComparison.Ordinal) && received is null,
                "sending nothing withdraws the account");

            var before = calls;
            Assert(Ask(JsonSerializer.Serialize(new { v = 1, op = "set-country-table-account", configuration = new string('x', 70_000) }))
                .Contains("invalid-configuration", StringComparison.Ordinal) && calls == before,
                "a file far too large to be a GeoIP.conf is refused before the service reads it");

            var kinds = new List<string>();
            foreach (var kind in new[] { "geo", "threat", "country", "all", "weather" })
                IpcProtocol.Handle(JsonSerializer.Serialize(new { v = 1, op = "refresh-enrichment", kind }),
                    () => "{}", _ => [], requestEnrichmentNow: accepted => kinds.Add(accepted));
            Assert(kinds is ["geo", "threat", "country", "all"],
                "the country table can be refreshed by hand like the other two, and nothing else can");

            Assert(IpcProtocol.Handle("""{"v":1,"op":"set-country-table-account"}""", () => "{}", _ => [])
                .Contains("operation-unavailable", StringComparison.Ordinal),
                "a build without the country table says so rather than silently accepting");
        }

        // Where the indicators came from is remembered, because a count and a
        // timestamp never said it.
        {
            var sourced = Path.Combine(directory, "threat-source.db");
            using var store = new ObservationStore(sourced);
            Assert(store.ReadThreatCacheState().Source == "none",
                "a database that has fetched nothing says so, rather than naming a source it never used");

            var now = DateTimeOffset.UtcNow;
            store.ReplaceThreatIndicators(true, [new ThreatIndicator("ip", "203.0.113.9", "feodo", "malware", "high")],
                "etag-1", now, "hub");
            Assert(store.ReadThreatCacheState().Source == "hub", "the Hub is named when the Hub answered");

            store.ReplaceThreatIndicators(true, [new ThreatIndicator("ip", "203.0.113.9", "feodo", "malware", "high")],
                null, now, "public-feeds-fallback");
            var state = store.ReadThreatCacheState();
            Assert(state.Source == "public-feeds-fallback",
                "falling back is not the same as choosing the public lists, and the screen can tell them apart");
            Assert(state.IndicatorCount == 1, "the indicators themselves are unaffected by where they came from");

            store.MarkThreatCacheFetched("etag-1", now, "hub");
            Assert(store.ReadThreatCacheState().Source == "hub",
                "a 304 means the data in use is still the Hub's, so the screen must not fall back to saying none");
        }

        // The switch that turns the country table off, which is not the switch
        // that forgets the account.
        {
            var replies = new List<string>();
            var wanted = new List<bool>();
            string Ask(string request) => IpcProtocol.Handle(request, () => "{}", _ => [],
                setCountryTableEnabled: enabled => { wanted.Add(enabled); return enabled; });

            replies.Add(Ask("""{"v":1,"op":"set-country-table-enabled","enabled":true}"""));
            replies.Add(Ask("""{"v":1,"op":"set-country-table-enabled","enabled":false}"""));
            Assert(wanted is [true, false] && replies[0].Contains("\"enabled\":true", StringComparison.Ordinal)
                && replies[1].Contains("\"enabled\":false", StringComparison.Ordinal),
                "the reply says what the setting is now, not what was asked for");

            Assert(Ask("""{"v":1,"op":"set-country-table-enabled"}""")
                .Contains("invalid-request", StringComparison.Ordinal) && wanted.Count == 2,
                "a switch with nothing to set is refused rather than read as off");

            var fetched = 0;
            Assert(IpcProtocol.Handle("""{"v":1,"op":"fetch-public-feeds-once"}""", () => "{}", _ => [],
                fetchPublicFeedsOnce: () => fetched++).Contains("\"status\":\"ok\"", StringComparison.Ordinal) && fetched == 1,
                "fetching once asks for exactly one fetch");
            Assert(IpcProtocol.Handle("""{"v":1,"op":"fetch-public-feeds-once"}""", () => "{}", _ => [])
                .Contains("operation-unavailable", StringComparison.Ordinal),
                "a build without the public feeds says so rather than silently accepting");
        }

        // An address bought one at a time is not thrown away by the next
        // cache fetch. It came out of a daily allowance of five hundred;
        // losing it means buying it again, which is how 132 of that allowance
        // went on addresses already placed once.
        {
            var keepDatabase = Path.Combine(directory, "keep-lookups.db");
            using var store = new ObservationStore(keepDatabase);
            var now = DateTimeOffset.UtcNow;

            store.ReplaceGeoLocations([new GeoLocation("8.8.8.8", 37.4, -122.0, "US", "Mountain View")], "etag-a", now);
            store.SaveGeoLocations([new GeoLocation("9.9.9.9", 47.6, -122.3, "US", null)]);
            Assert(store.ReadGeoCacheState().LocationCount == 2 && store.ReadLookedUpLocationCount() == 1,
                "both sources sit in the same table, and the bought ones can be counted");

            // A new cache arrives that knows nothing about the bought address.
            store.ReplaceGeoLocations([new GeoLocation("1.1.1.1", -33.8, 151.2, "AU", "Sydney")], "etag-b", now);
            var kept = store.ReadGlobePoints(now.AddHours(-1), now.AddHours(1));
            Assert(store.ReadLookedUpLocationCount() == 1,
                "replacing the Hub's cache does not take away an address the Agent paid to place");
            Assert(store.ReadGeoCacheState().LocationCount == 2,
                "and the Hub's own rows are still replaced rather than accumulated");

            // The Hub catching up on an address wins: it carries a city.
            store.ReplaceGeoLocations([
                new GeoLocation("1.1.1.1", -33.8, 151.2, "AU", "Sydney"),
                new GeoLocation("9.9.9.9", 47.6, -122.3, "US", "Seattle"),
            ], "etag-c", now);
            Assert(store.ReadLookedUpLocationCount() == 0 && store.ReadGeoCacheState().LocationCount == 2,
                "the Hub's richer answer takes over the address, rather than colliding with it");
        }

        // An address a lookup could not place is not asked about again, for a
        // while. Without this, the addresses that can never be placed are
        // exactly the ones asked about on every run, for ever -- and they
        // spend the whole daily allowance the placeable ones needed.
        {
            var missDatabase = Path.Combine(directory, "geo-misses.db");
            using var store = new ObservationStore(missDatabase);
            Assert(store.SchemaVersion >= 20, "the lookup-miss memory arrives with schema 20");
            var now = DateTimeOffset.UtcNow;
            store.WriteBatch([
                new NetworkObservation(now.AddMinutes(-1), 41, "TCP", "10.0.0.4", 53_000, "8.8.4.4", 443,
                    10, 10, ObservationLayer.Logical, null, "etw", "resolver"),
                new NetworkObservation(now.AddMinutes(-1), 42, "TCP", "10.0.0.4", 53_001, "9.9.9.9", 443,
                    10, 10, ObservationLayer.Logical, null, "etw", "resolver"),
            ]);

            Assert(store.ReadAddressesWithoutLocation(now.AddHours(-1)).Count == 2, "both start out unplaced");
            store.RecordGeoLookupMisses(["9.9.9.9"], now);
            var asked = store.ReadAddressesWithoutLocation(now.AddHours(-1));
            Assert(asked.Contains("8.8.4.4") && !asked.Contains("9.9.9.9"),
                "the one that could not be placed is left alone; the one never tried is still asked about");

            store.RecordGeoLookupMisses(["9.9.9.9"], now - ObservationStore.MissRetryAfter.Add(TimeSpan.FromMinutes(1)));
            Assert(store.ReadAddressesWithoutLocation(now.AddHours(-1)).Contains("9.9.9.9"),
                "after a week it is tried again, because allocations move and this is a delay not a verdict");

            store.SaveGeoLocations([new GeoLocation("8.8.4.4", 37.4, -122.0, "US", "Mountain View")]);
            Assert(!store.ReadAddressesWithoutLocation(now.AddHours(-1)).Contains("8.8.4.4"),
                "a placed address leaves the list without discarding the locations already held");
        }

        // The conversation handed to the model runs forwards, whatever order
        // the screen shows it in.
        {
            var conversation = Guid.NewGuid();
            var start = new DateTimeOffset(2026, 9, 19, 20, 0, 0, TimeSpan.Zero);
            AiConversationMessage Say(string role, string body, int minute) =>
                new(Guid.NewGuid(), conversation, role, body, start.AddMinutes(minute), "Ollama", "qwen:latest");
            IReadOnlyList<AiConversationMessage> history =
            [
                Say("user", "first question", 0), Say("assistant", "first answer", 1),
                Say("user", "second question", 2), Say("assistant", "second answer", 3),
            ];

            using var client = new AgentAiClient(new StubHandler(_ => "{}"));
            var counts = new AiInsightCounts(1, 1, 1, 1, 0);
            var context = new AiInsightContext(1, start, start.AddHours(-1), start, counts, counts, [], []);
            var preview = client.BuildPreview(AiProviderKind.Ollama, "qwen:latest", context, history, "third question");
            var first = preview.IndexOf("first question", StringComparison.Ordinal);
            var second = preview.IndexOf("second question", StringComparison.Ordinal);
            Assert(first >= 0 && second > first,
                "what the model is told stays in the order it was said, however the window lists it");
        }

        // A local model gets longer than a cloud one, because the wait is a
        // different thing.
        {
            Assert(AgentAiClient.LocalModelDeadline > AgentAiClient.CloudDeadline,
                "arithmetic on this PC is given more time than a stalled network");
            Assert(AgentAiClient.CloudDeadline == TimeSpan.FromSeconds(30),
                "a cloud provider that has not answered in thirty seconds is not going to");
            Assert(AgentAiClient.LocalModelDeadline >= TimeSpan.FromMinutes(1),
                "long enough that loading a large model off disk is not reported as a failure");

            // The deadline is the client's, not the handler's, so a handler
            // that never answers must still end the request.
            using var stalling = new AgentAiClient(new HangingHandler());
            var kind = AiFailureKind.Empty;
            using var giveUp = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            try { await stalling.ListOllamaModelsAsync("http://127.0.0.1:11434", giveUp.Token); }
            catch (AiRequestException exception) { kind = exception.Kind; }
            catch (OperationCanceledException) { kind = AiFailureKind.Timeout; }
            Assert(kind == AiFailureKind.Timeout, "a request that never comes back ends rather than waiting for ever");
        }

        // The models this PC has, asked for rather than typed.
        {
            var handler = new StubHandler(request =>
            {
                Assert(request.RequestUri!.AbsolutePath == "/api/tags",
                    "the model list comes from Ollama's own tags endpoint");
                return """
                {"models":[
                  {"name":"qwen:latest","size":1},
                  {"name":"gemma4:26b","size":2},
                  {"name":"qwen:latest","size":1},
                  {"name":"","size":3}
                ]}
                """;
            });
            using var client = new AgentAiClient(handler);
            var models = await client.ListOllamaModelsAsync("http://127.0.0.1:11434", CancellationToken.None);
            Assert(models is ["gemma4:26b", "qwen:latest"],
                "every installed model is offered once, in an order a person can scan");

            var rejected = false;
            try { await client.ListOllamaModelsAsync("http://example.com:11434", CancellationToken.None); }
            catch (AiRequestException exception) { rejected = exception.Kind == AiFailureKind.RequestRejected; }
            Assert(rejected, "the model list is only ever asked of this PC, never of a host somewhere else");

            using var empty = new AgentAiClient(new StubHandler(_ => """{"models":[]}"""));
            Assert((await empty.ListOllamaModelsAsync("http://127.0.0.1:11434", CancellationToken.None)).Count == 0,
                "an Ollama with nothing installed answers with nothing, which is a state and not a failure");

            using var broken = new AgentAiClient(new StubHandler(_ => """{"ok":true}"""));
            var unreadable = false;
            try { await broken.ListOllamaModelsAsync("http://127.0.0.1:11434", CancellationToken.None); }
            catch (AiRequestException exception) { unreadable = exception.Kind == AiFailureKind.Unreadable; }
            Assert(unreadable,
                "a reply without a model list is a fault, not an empty list, so the screen does not say there are none");
        }

        // The addresses that must never be asked about.
        //
        // Measured on one PC while this was being written: 129 of 200 recent
        // destinations were private or reserved. Sending those to a third
        // party would hand over the shape of the reader's own network, one
        // address at a time, in exchange for nothing an answer could give.
        //
        // The examples below are documentation ranges on purpose. The
        // addresses that prompted this were somebody's real subnet, and a test
        // file is published: writing them down here would have been a smaller
        // version of the same mistake.
        {
            string[] unaskable =
            [
                "10.0.0.1", "192.168.0.1", "192.168.0.255", "172.16.0.1", "172.31.255.254",
                "127.0.0.1", "169.254.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.251", "255.255.255.255",
                "::1", "fe80::1", "fd00::1", "198.51.100.7", "203.0.113.9", "192.0.2.1",
            ];
            foreach (var address in unaskable)
                Assert(PrivateAddress.IsPrivateOrReserved(address),
                    $"{address} is never sent anywhere, because nothing outside this network can place it");

            string[] askable = ["8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "100.63.255.255",
                "100.128.0.1", "192.167.1.1", "2606:4700:4700::1111"];
            foreach (var address in askable)
                Assert(!PrivateAddress.IsPrivateOrReserved(address),
                    $"{address} is a real destination and must not be filtered away with the private ones");

            Assert(PrivateAddress.Routable(["10.0.0.1", "8.8.8.8", "192.168.1.1", "1.1.1.1"]) is ["8.8.8.8", "1.1.1.1"],
                "filtering keeps the routable ones in the order they arrived");
            Assert(!PrivateAddress.IsPrivateOrReserved("not-an-address"),
                "something that is not an address is left to the caller rather than silently dropped");
        }

        // The one path that sends a watched address outside.
        {
            var asked = new List<string>();
            var handler = new StubHandler(request =>
            {
                asked.Add(request.RequestUri!.ToString());
                var address = request.RequestUri!.AbsolutePath.Trim('/');
                return address == "198.51.100.7"
                    ? """{"success":true,"ip":"198.51.100.7","country_code":"DE","latitude":52.5,"longitude":13.4,"city":"Berlin"}"""
                    : """{"success":false,"message":"Reserved range"}""";
            });
            var lookup = new ThirdPartyGeoLookup(new HttpClient(handler), new Uri("https://ipwho.is"),
                (_, _) => Task.CompletedTask);

            var located = await lookup.LookUpAsync(["198.51.100.7", "10.0.0.1"], budget: 10);
            Assert(located.Count == 1 && located[0].Ip == "198.51.100.7" && located[0].CountryCode == "DE",
                "an address the service cannot place is left out, because a wrong country is worse than none");
            Assert(located[0].Latitude == 52.5 && located[0].City == "Berlin",
                "the coordinates the globe needs come back with it");
            Assert(lookup.Spent == 2, "the budget is spent by asking, not by being answered");

            Assert(asked.All(url => url.StartsWith("https://", StringComparison.Ordinal)),
                "watched addresses are never sent in clear text by a tool whose purpose is showing what leaves");
            Assert(asked[0].Contains("198.51.100.7", StringComparison.Ordinal) &&
                !asked[0].Contains("10.0.0.1", StringComparison.Ordinal),
                "one address per request, and only the address being asked about");

            asked.Clear();
            await lookup.LookUpAsync(["198.51.100.7", "198.51.100.8", "198.51.100.9"], budget: 2);
            Assert(asked.Count == 2, "the day's budget stops the run, rather than being checked afterwards");
        }

        // A source nobody recognises is refused, in either direction.
        {
            var chosen = new List<GeoLookupSource>();
            string Ask(string wire) => IpcProtocol.Handle(
                JsonSerializer.Serialize(new { v = 1, op = "set-geo-lookup-source", source = wire }),
                () => "{}", _ => [], setGeoLookupSource: source => { chosen.Add(source); return source.ToWire(); });

            Assert(Ask("hub-then-third-party").Contains("hub-then-third-party", StringComparison.Ordinal)
                && chosen is [GeoLookupSource.HubThenThirdParty],
                "the choice that sends addresses outside is passed through exactly as asked");
            Assert(Ask("cache-only").Contains("cache-only", StringComparison.Ordinal), "so is the one that sends nothing");
            Assert(Ask("hub-then-ipwho").Contains("invalid-lookup-source", StringComparison.Ordinal)
                && chosen.Count == 3 - 1,
                "a misspelling is refused rather than falling through to a default, in either direction");
            Assert(GeoLookupSources.Parse("nonsense") == GeoLookupSource.Hub
                && !GeoLookupSource.Hub.UsesThirdParty() && GeoLookupSource.Hub.UsesHub(),
                "an unreadable stored setting means the Hub, which sends nothing outside the network");
        }

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

        // Which end of an event is this machine.
        //
        // The bug this pins was one of order. The inbound-multicast test used
        // to sit inside the sorting branch and was reached only when the group
        // was the destination; on a receive event the group is the source, so
        // "the destination is ours and the source is not" matched first. Every
        // process listening on 5353 was then charged for the same datagram --
        // 490 MiB an hour on one PC, which is what made an application look
        // like it was moving half a gigabyte.
        {
            // Documentation ranges, not the machine this was found on. The
            // addresses that prompted this were somebody's real subnet, and a
            // test file is published; the secret scan has caught me writing
            // them down once already today.
            const string local = "192.168.0.50";
            const string group4 = "224.0.0.251";
            const string group6 = "ff02::fb";

            // The shape that leaked: received, group as the SOURCE, this
            // machine as the destination.
            Assert(EtwNetworkCollector.SortEndpoints(group4, 5353, local, 5353,
                    sourceHasInterface: false, destinationHasInterface: true,
                    sourceMulticast: true, destinationMulticast: false, received: true) is null,
                "an inbound group datagram is left out even when the group is the source");

            Assert(EtwNetworkCollector.SortEndpoints(group6, 5353, local, 5353,
                    false, true, true, false, true) is null,
                "and over IPv6, where the same shape arrives as ff02::fb");

            // The shape that was already handled: group as the destination.
            Assert(EtwNetworkCollector.SortEndpoints("192.168.0.9", 5353, group4, 5353,
                    false, false, false, true, true) is null,
                "an inbound group datagram addressed to the group is still left out");

            // Outbound multicast is this machine announcing itself, and is kept.
            var announced = EtwNetworkCollector.SortEndpoints(local, 5353, group4, 5353,
                sourceHasInterface: true, destinationHasInterface: false,
                sourceMulticast: false, destinationMulticast: true, received: false);
            Assert(announced is { LocalAddress: local, RemoteAddress: group4, LocalIsSource: true },
                "what this machine sent to the group is traffic it sent, and is kept");

            // Ordinary traffic is unaffected, in both directions.
            var outbound = EtwNetworkCollector.SortEndpoints(local, 52000, "8.8.8.8", 443,
                true, false, false, false, false);
            Assert(outbound is { LocalAddress: local, RemoteAddress: "8.8.8.8", RemotePort: 443 },
                "an ordinary outbound flow still names the far end as the remote");
            var inbound = EtwNetworkCollector.SortEndpoints("8.8.8.8", 443, local, 52000,
                false, true, false, false, true);
            Assert(inbound is { LocalAddress: local, RemoteAddress: "8.8.8.8", LocalIsSource: false },
                "and an ordinary inbound flow names it the same way round");
        }

        // A row per packet, which the store could not absorb.
        //
        // An ETW network event is a packet, and the collector wrote one
        // observation for each. Measured on one machine: a single chrome
        // connection to a CDN produced 132,928 rows in 1.4 seconds against a
        // store that manages about a hundred a second. Widening the session
        // buffers, which was the previous answer, only turned the loss into a
        // delay -- event time advanced at one part in a thousand of real time,
        // so the Agent showed traffic from thirty-eight minutes earlier and
        // called itself healthy. The summing is what makes the write rate a
        // function of how many flows are active rather than how fast the link
        // is.
        {
            var start = new DateTimeOffset(2026, 9, 20, 12, 0, 0, TimeSpan.Zero);
            NetworkObservation Packet(DateTimeOffset at, long sent, long received, int port = 51000, string? name = "chrome") =>
                new(at, 42, "TCP", "10.0.0.1", port, "203.0.113.42", 443, sent, received,
                    ObservationLayer.Logical, null, "etw", name);

            var coalescer = new ObservationCoalescer();
            var emitted = new List<NetworkObservation>();
            // Ten thousand packets inside one second, as a saturated
            // connection delivers them.
            for (var i = 0; i < 10_000; i++)
                emitted.AddRange(coalescer.Add(Packet(start.AddTicks(i * 100), 10, 20)));
            Assert(emitted.Count == 0 && coalescer.OpenFlows == 1,
                "packets of one flow inside one second are held as one row, not ten thousand");

            // The bucket closes once the event timeline has moved past it and
            // the tolerance for out-of-order callbacks with it.
            emitted.AddRange(coalescer.Expire(start.AddSeconds(3)));
            Assert(emitted.Count == 1 && emitted[0].BytesSent == 100_000 && emitted[0].BytesReceived == 200_000,
                "the row that comes out carries the sum of what it replaced");
            Assert(emitted[0].ObservedAt == start && emitted[0].ProcessName == "chrome" &&
                emitted[0].RemoteAddress == "203.0.113.42" && emitted[0].Protocol == "TCP",
                "and is otherwise the flow it came from, timed when its traffic began");
            Assert(coalescer.Folded == 9_999 && coalescer.Emitted == 1,
                "the counters report the compression rather than leaving it to be assumed");

            // Different seconds are different rows, and different flows are
            // never summed together.
            var perSecond = new ObservationCoalescer();
            var rows = new List<NetworkObservation>();
            rows.AddRange(perSecond.Add(Packet(start, 1, 0)));
            rows.AddRange(perSecond.Add(Packet(start.AddMilliseconds(999), 2, 0)));
            rows.AddRange(perSecond.Add(Packet(start.AddSeconds(1), 4, 0)));
            rows.AddRange(perSecond.Add(Packet(start.AddSeconds(1), 8, 0, port: 51001)));
            rows.AddRange(perSecond.Drain());
            Assert(rows.Count == 3 && rows.Sum(row => row.BytesSent) == 15,
                "a second boundary and a different local port each start their own row, and nothing is lost");

            var instances = new ObservationCoalescer();
            instances.Add(Packet(start, 1, 0) with { ProcessInstanceId = "pid:42:start:1" });
            instances.Add(Packet(start, 2, 0) with { ProcessInstanceId = "pid:42:start:2" });
            Assert(instances.Drain().Count() == 2,
                "the same PID and endpoints from different process instances never coalesce");

            // An unmeasured packet must not be turned into a measured zero:
            // the store and the screen both distinguish "we do not know" from
            // "none", and the period totals count the first separately.
            var unknown = new ObservationCoalescer();
            var unknownRows = new List<NetworkObservation>();
            // Two of them, so the summing is actually reached: one packet
            // alone never calls it, and a test that never calls it passed a
            // version that turned every unmeasured byte count into zero.
            unknownRows.AddRange(unknown.Add(Packet(start, 0, 0) with { BytesSent = null, BytesReceived = null }));
            unknownRows.AddRange(unknown.Add(Packet(start, 0, 0) with { BytesSent = null, BytesReceived = null }));
            unknownRows.AddRange(unknown.Drain());
            Assert(unknownRows.Single() is { BytesSent: null, BytesReceived: null },
                "a flow whose bytes were never reported still reads as unmeasured after summing");
            var partial = new ObservationCoalescer();
            partial.Add(Packet(start, 0, 0) with { BytesSent = null, BytesReceived = null });
            partial.Add(Packet(start, 5, 0) with { BytesReceived = null });
            Assert(partial.Drain().Single() is { BytesSent: 5, BytesReceived: null },
                "and one measured packet among unmeasured ones gives the row what is known, and no more");

            // The bound has to do something rather than grow without limit,
            // and what it does must not be to drop traffic -- a port scan is
            // the shape that reaches it.
            var flooded = new ObservationCoalescer();
            var flushed = new List<NetworkObservation>();
            for (var i = 0; i <= ObservationCoalescer.MaximumOpenFlows; i++)
                flushed.AddRange(flooded.Add(Packet(start, 1, 0, port: 20_000 + i)));
            Assert(flooded.Overflows == 1 && flushed.Count == ObservationCoalescer.MaximumOpenFlows + 1 &&
                flooded.OpenFlows == 0,
                "reaching the ceiling on open flows emits what is held instead of dropping it");
        }

        // A trace session that is up and delivering nothing.
        //
        // Subscribing to two keywords the network provider does not define
        // produced exactly this: the session ran, process and DNS events kept
        // arriving, no network event did, and the agent reported "healthy" for
        // three minutes because nothing had been lost -- nothing had arrived.
        {
            var silent = new CollectorSnapshot("healthy", 0, 0, 0, 0, null, null, 0)
            { EtwSessionActive = true, EtwEventsSeen = 0, NamesFromStartEvents = 874, DnsEventsSeen = 329 };
            var health = AgentHealth.Evaluate(silent, "ok");
            Assert(health.Issues.Any(issue => issue.Code == "etw-network-silent") && health.Status != "healthy",
                "a monitor recording nothing is never the same colour as one that is working");

            // The control: all three quiet is a quiet machine, not a fault.
            var quiet = silent with { NamesFromStartEvents = 0, DnsEventsSeen = 0 };
            Assert(!AgentHealth.Evaluate(quiet, "ok").Issues.Any(issue => issue.Code == "etw-network-silent"),
                "a machine with no traffic at all is not reported as broken");

            // And a session that is delivering is not reported either.
            var working = silent with { EtwEventsSeen = 1 };
            Assert(!AgentHealth.Evaluate(working, "ok").Issues.Any(issue => issue.Code == "etw-network-silent"),
                "one network event is enough to show the subscription is right");
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
            Assert(reopened.SchemaVersion == 29 && reopened.ReadRunHistory().Count == 3,
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
            // Two peers over UDP from one local socket are distinct
            // conversations, just like distinct TCP endpoints.
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
        Assert(stored.Count == 5, "two UDP peers and three TCP ports are five conversations");
        foreach (var row in folded)
        {
            var match = stored.Single(other =>
                StartupSnapshot.FlowKey(other.Protocol, other.LocalAddress, other.LocalPort, other.RemoteAddress, other.RemotePort, other.ProcessId, other.ProcessInstanceId) ==
                StartupSnapshot.FlowKey(row.Protocol, row.LocalAddress, row.LocalPort, row.RemoteAddress, row.RemotePort, row.ProcessId, row.ProcessInstanceId));
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

Console.WriteLine("PASS: persistence, migration backup, corruption/disk-full gates, snapshot upsert, coverage, bounded drops, and privacy-safe diagnostics, process-name retention, rejection reasons, globe geometry, run history, connection-log grain, log streaming, IPC context independence, shutdown drain reporting, system-shutdown endings, window run reports, outbound anomalies, portable settings, directional period totals, risk-led integrity checks, public threat feeds, startup event loss, the local country table, its update, its expiry, handing over the account, where threat data came from, looking an address up outside, the addresses that are never asked about, not asking twice, not paying twice, the models on this PC, how long a local one is given, and the order a conversation is handed over in");
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

/// Wraps a database in the tar.gz MaxMind serves, so the extraction is tested
/// against the shape of the real thing rather than around it.
static byte[] BuildGeoArchive(byte[] database)
{
    using var tarBytes = new MemoryStream();
    using (var writer = new System.Formats.Tar.TarWriter(tarBytes, leaveOpen: true))
    {
        var entry = new System.Formats.Tar.PaxTarEntry(System.Formats.Tar.TarEntryType.RegularFile,
            "GeoLite2-Country_20260919/GeoLite2-Country.mmdb")
        { DataStream = new MemoryStream(database) };
        writer.WriteEntry(entry);
    }
    using var gzipped = new MemoryStream();
    using (var gzip = new System.IO.Compression.GZipStream(gzipped, System.IO.Compression.CompressionMode.Compress, leaveOpen: true))
        gzip.Write(tarBytes.ToArray());
    return gzipped.ToArray();
}

static void AssertMaxMindFailure(Func<MaxMindDatabase> open, MaxMindFailureKind expected, string message)
{
    try { open(); }
    catch (MaxMindException exception) when (exception.Kind == expected) { return; }
    throw new InvalidOperationException($"FAILED: {message}");
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

/// Answers one download with bytes rather than a string, and remembers how it
/// was asked.
sealed class GeoLite2Handler(HttpStatusCode status, byte[] body) : HttpMessageHandler
{
    public System.Net.Http.Headers.AuthenticationHeaderValue? Authorization { get; private set; }
    public Uri? RequestedUri { get; private set; }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        Authorization = request.Headers.Authorization;
        RequestedUri = request.RequestUri;
        return Task.FromResult(new HttpResponseMessage(status) { Content = new ByteArrayContent(body) });
    }
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

/// Answers HTTP requests from a function, so a lookup can be tested without a
/// network and without a third party learning anything.
file sealed class StubHandler(Func<HttpRequestMessage, string> reply) : HttpMessageHandler
{
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
        Task.FromResult(new HttpResponseMessage(System.Net.HttpStatusCode.OK)
        {
            Content = new StringContent(reply(request), System.Text.Encoding.UTF8, "application/json"),
        });
}

/// Never answers, so a deadline is the only thing that can end the request.
file sealed class HangingHandler : HttpMessageHandler
{
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        await Task.Delay(Timeout.Infinite, cancellationToken);
        throw new InvalidOperationException("unreachable");
    }
}
