using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Controls;
using System.Windows.Threading;
using EgressView.Agent.Core;
using Microsoft.Win32;

namespace EgressView.Agent.Ui;

public partial class MainWindow : Window
{
    public const double MinimumWindowWidth = 1020;
    private readonly AgentEnrollmentClient enrollment = new();
    private readonly CancellationTokenSource lifetime = new();
    /// How often the visible tab is re-read. Named rather than inlined so the
    /// things derived from it -- what counts as still running, above all --
    /// move with it instead of being left behind.
    internal static readonly TimeSpan LogRefreshInterval = TimeSpan.FromSeconds(5);
    /// How often the log asks what has happened since it last looked.
    ///
    /// Short because the point of the log is to show traffic as it happens,
    /// and affordable because the question is bounded: events after a cursor,
    /// capped. The slower full read stays, as reconciliation -- retention and
    /// enrichment change rows that no event mentions, so a view built only
    /// from the stream would drift away from the store.
    internal static readonly TimeSpan LogStreamInterval = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan EnrichmentRefreshInterval = TimeSpan.FromSeconds(30);
    private const int LogStreamBatch = 500;
    private readonly DispatcherTimer refreshTimer = new() { Interval = LogRefreshInterval };
    private readonly DispatcherTimer logStreamTimer = new() { Interval = LogStreamInterval };
    private readonly DispatcherTimer countryAtlasTimer = new() { Interval = LogStreamInterval };
    private long logCursor;
    private long countryAtlasCursor;
    private bool countryAtlasStreaming;
    private IReadOnlySet<string> allCountryCodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    private bool logStreaming;
    private bool logSnapshotReading;
    private bool refreshingVisible;
    private long logOmitted;
    private bool loadingSettings;
    private bool loadingDeliveryState;
    private int selectedMinutes = 10_080;
    private IReadOnlyList<RecentFlow> rawFlows = [];
    private DateTimeOffset rawFlowsReadAt = DateTimeOffset.UtcNow;
    /// When paused, the log stops reading and says which moment it is showing.
    /// Something that scrolls cannot be read unless it can be held still, and
    /// a held view that does not admit it is held is worse than a stale one.
    private bool logPaused;
    private DateTimeOffset? logPausedAt;
    private PeriodAnalysis? currentAnalysis;
    private PeriodAnalysis? previousAnalysis;
    private IReadOnlyList<GlobePoint> currentGlobePoints = [];
    private int allTimeCountryCount;
    private DateTimeOffset countryHistoryReadAt = DateTimeOffset.MinValue;
    private DateTimeOffset threatReadAt = DateTimeOffset.MinValue;
    private readonly AgentAiClient aiClient = new();
    private readonly AiConversationStore aiHistory = new(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EgressView", "Agent", "ai-conversations.jsonl"));
    private CancellationTokenSource? aiRequest;
    private Guid activeConversationId = Guid.NewGuid();
    private bool loadingAiConversation;
    private bool loadingHistorySettings;
    private DateTimeOffset? historyOldestRaw;
    public ObservableCollection<FlowRow> RecentFlows { get; } = [];
    public ObservableCollection<ThreatRow> ThreatRows { get; } = [];

    public MainWindow()
    {
        InitializeComponent();
        // The truthful state label is longer than the former "Active" flag.
        ConnectionGrid.Columns[2].Width = new DataGridLength(110);
        if (aiHistory.Read().OrderByDescending(item => item.CreatedAt).FirstOrDefault() is { } latest)
            activeConversationId = latest.ConversationId;
        Width = Math.Min(AgentSettings.WindowWidth, SystemParameters.WorkArea.Width);
        Height = Math.Min(AgentSettings.WindowHeight, SystemParameters.WorkArea.Height);
        ApplyAccessibilityLabels();
        DataContext = this;
        Loaded += async (_, _) => { LoadSettings(); await RefreshAllAsync(); refreshTimer.Start(); };
        IsVisibleChanged += (_, _) => { if (IsVisible) refreshTimer.Start(); else refreshTimer.Stop(); };
        refreshTimer.Tick += async (_, _) =>
        {
            if (!IsVisible || WindowState == WindowState.Minimized || refreshingVisible) return;
            refreshingVisible = true;
            try { await RefreshVisibleAsync(); }
            catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
            catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
            finally { refreshingVisible = false; }
        };
        logStreamTimer.Tick += async (_, _) => await StreamLogAsync();
        countryAtlasTimer.Tick += async (_, _) => await StreamCountryAtlasAsync();
        // Nothing streams towards a window nobody is looking at. A background
        // window that kept asking every two seconds would spend a laptop's
        // battery to update a picture no one can see.
        Activated += (_, _) => ReconcileLogStream();
        Deactivated += (_, _) => ReconcileLogStream();
        IsVisibleChanged += (_, _) => ReconcileLogStream();
        StateChanged += (_, _) => ReconcileLogStream();
        Activated += (_, _) => ReconcileCountryAtlasStream();
        Deactivated += (_, _) => ReconcileCountryAtlasStream();
        IsVisibleChanged += (_, _) => ReconcileCountryAtlasStream();
        StateChanged += (_, _) => ReconcileCountryAtlasStream();
        Closing += SaveWindowSize;
        Closing += HideToTray;
        Closed += (_, _) => { refreshTimer.Stop(); countryAtlasTimer.Stop(); lifetime.Cancel(); aiRequest?.Cancel(); aiClient.Dispose(); };
    }

    private void HideToTray(object? sender, CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App { IsExiting: false }) { e.Cancel = true; Hide(); }
    }

    private void SaveWindowSize(object? sender, CancelEventArgs e)
    {
        if (WindowState != WindowState.Normal) return;
        AgentSettings.WindowWidth = ActualWidth;
        AgentSettings.WindowHeight = ActualHeight;
    }

    internal void SelectTab(int index)
    {
        MainTabs.SelectedIndex = Math.Clamp(index, 0, MainTabs.Items.Count - 1);
        // The change handler stops early before the window has loaded, and a
        // restored tab arrives that way, so the period would be left showing
        // on a tab it does not act on until the reader changed tabs once.
        ShowPeriodWhereItApplies();
    }

    internal Task RefreshStatusFromTrayAsync() => RefreshStatusAsync();

    /// How much of the period was actually watched: a proportion, or nothing
    /// when there is no answer yet.
    ///
    /// The card was written from three places, and two of them put a word in
    /// it -- "monitoring", "needs attention", "monitoring stopped" -- while the
    /// third put a percentage. Whichever updater ran last won, so the same
    /// state showed "99.1%" and "monitoring" by turns while the sentence under
    /// the card went on quoting the percentage either way: one screen giving
    /// two answers to the same question.
    ///
    /// The word was never this card's to show. It is the badge's, and the
    /// badge already carries it twice on this screen -- beside the title and
    /// under the period summary. Taking a ratio rather than a string is what
    /// stops it coming back.
    private void SetCoverage(double? ratio) =>
        CoverageValue.Text = ratio is not { } value ? "—"
            : value >= 0.999999999
                ? "100%"
                : $"{Math.Min(value, 0.999):P1}";

    internal void ApplyMonitoringStatusFromTray(bool enabled, bool healthy, bool hasActiveCoverage, string? issueCode, string? issueAction) =>
        // The state goes to the badge. Whether monitoring is running says
        // nothing about how much of the period was covered, which is what this
        // card is asked for, and the analysis answers that on its own.
        SetMonitoringState(healthy, enabled, issueCode, issueAction);

    internal void ApplyMonitoringUnavailableFromTray(DateTimeOffset? lastConfirmedAt)
    {
        SetMonitoringUnavailable(lastConfirmedAt);
        // Not the last figure: it was true of a period this one cannot vouch
        // for. The badge says the status could not be read.
        SetCoverage(null);
    }

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshAllAsync();
    private async void PeriodChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || PeriodChoice.SelectedItem is not ComboBoxItem item || !int.TryParse(item.Tag?.ToString(), out selectedMinutes)) return;
        if (!loadingSettings) AgentSettings.PeriodMinutes = selectedMinutes;
        threatReadAt = DateTimeOffset.MinValue;
        await RefreshVisibleAsync();
    }

    private async void AnalysisChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        if (!loadingSettings)
        {
            AgentSettings.Metric = MetricChoice.SelectedIndex == 1 ? "bytes" : "connections";
            AgentSettings.DestinationUnit = DestinationChoice.SelectedIndex == 1 ? "ip" : "name";
        }
        RenderAnalysis();
        await Task.CompletedTask;
    }

    private async Task RefreshAllAsync()
    {
        await RefreshStatusAsync();
        await RefreshNetworkAsync();
        await RefreshFlowsAsync();
        await RefreshThreatsAsync();
        RefreshNotifications();
    }

    private Task RefreshVisibleAsync() => MainTabs.SelectedIndex switch
    {
        0 => RefreshNetworkAsync(),
        1 => RefreshInsightsAsync(),
        2 => RefreshFlowsAsync(),
        3 => DateTimeOffset.UtcNow - threatReadAt >= EnrichmentRefreshInterval ? RefreshThreatsAsync() : Task.CompletedTask,
        _ => RefreshStatusAsync(),
    };

    private async Task RefreshNetworkAsync()
    {
        try
        {
            currentAnalysis = await ReadAnalysisAsync(selectedMinutes);
            RenderAnalysis();
            var globeResponse = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "globe", minutes = selectedMinutes }), lifetime.Token);
            using var globeDocument = JsonDocument.Parse(globeResponse);
            currentGlobePoints = globeDocument.RootElement.GetProperty("data").Deserialize<List<GlobePoint>>() ?? [];
            Globe.SetPoints(currentGlobePoints);
            if (DateTimeOffset.UtcNow - countryHistoryReadAt >= EnrichmentRefreshInterval)
                await RefreshCountryHistoryAsync();
            GlobeCaption.Text = currentGlobePoints.Count == 0
                ? allTimeCountryCount == 0 ? GlobeUnavailableText()
                    : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("GlobeHistoryOnly"), allTimeCountryCount)
                : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("GlobeLocationsWithHistory"), currentGlobePoints.Count, allTimeCountryCount);
            AutomationProperties.SetHelpText(Globe, GlobeCaption.Text);
            if (DateTimeOffset.UtcNow - threatReadAt >= EnrichmentRefreshInterval)
                await RefreshThreatsAsync();
            NetworkLastUpdated.Text = string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("NetworkUpdatedAt"), DateTime.Now.ToString("T", CultureInfo.CurrentCulture));
        }
        catch (Exception exception)
        {
            NetworkLastUpdated.Text = UnavailableText(LocalizationManager.Text("CannotConnect"));
            LogStatus.Text = $"{UnavailableText(LocalizationManager.Text("CannotConnect"))}: {exception.Message}";
        }
    }

    private async Task RefreshCountryHistoryAsync()
    {
        var allResponse = await AgentIpcClient.RequestAsync(
            JsonSerializer.Serialize(new { v = 1, op = "country-history", scope = "all" }), lifetime.Token);
        using var allDocument = JsonDocument.Parse(allResponse);
        var allRows = allDocument.RootElement.GetProperty("data").Deserialize<List<CountryHistoryRow>>() ?? [];
        allTimeCountryCount = allRows.Count;
        allCountryCodes = allRows.Select(row => row.CountryCode).ToHashSet(StringComparer.OrdinalIgnoreCase);
        Globe.SetVisitedCountries(allRows.Select(row => row.CountryCode));
        CountryMap.SetVisitedCountries(allRows.Select(row => row.CountryCode));
        ExpandedCountryList.ItemsSource = allRows.Select(CountryHistoryDisplayRow.From).ToArray();
        ExpandedCountryCount.Text = string.Format(CultureInfo.CurrentCulture,
            LocalizationManager.Text("CountryAtlasCount"), CountryMap.MappedCountryCount, allRows.Count);
        AutomationProperties.SetHelpText(CountryMap, ExpandedCountryCount.Text);
        CountryList.ItemsSource = allRows.Select(CountryHistoryDisplayRow.From).ToArray();
        CountryEmptyNote.Visibility = allRows.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        countryHistoryReadAt = DateTimeOffset.UtcNow;
    }

    private async Task RefreshFlowsAsync()
    {
        // Paused means paused: no read, no query, no work. Holding the picture
        // while still asking for it would spend the same effort to show less.
        if (logPaused || logSnapshotReading || logStreaming) return;
        logSnapshotReading = true;
        try
        {
            var limit = SelectedLimit();
            var snapshot = await ReadLogSnapshotAsync(limit, ObservationGrain);
            rawFlows = snapshot.Rows;
            rawFlowsReadAt = DateTimeOffset.UtcNow;
            logCursor = snapshot.Cursor;
            logOmitted = 0;
            PopulateCountryFilter();
            ApplyLogFilter();
            ReconcileLogStream();
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
        finally { logSnapshotReading = false; }
    }

    private async Task<PeriodAnalysis> ReadAnalysisAsync(int minutes)
    {
        var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "analysis", minutes }), lifetime.Token);
        using var document = JsonDocument.Parse(response);
        return document.RootElement.GetProperty("data").Deserialize<PeriodAnalysis>() ?? throw new InvalidDataException("Missing analysis response.");
    }

    private bool IsByteMetric => MetricChoice.SelectedIndex == 1;

    private void RenderAnalysis()
    {
        if (currentAnalysis is not { } data) return;
        ConnectionCount.Text = data.Connections.ToString("N0");
        ApplicationCount.Text = data.Applications.ToString("N0");
        DestinationCount.Text = data.Destinations.ToString("N0");
        SentVolumeValue.Text = FlowRow.FormatBytes(data.BytesSent);
        ReceivedVolumeValue.Text = FlowRow.FormatBytes(data.BytesReceived);
        // A dash, not a zero, until the detector has a day of measured
        // windows: "none found" and "not yet able to say" are different
        // answers and a 0 would present the second as the first.
        OutboundAnomalyCount.Text = data.OutboundAnomalies > 0
            ? data.OutboundAnomalies.ToString("N0")
            : data.OutboundBaselineReady ? "0" : "—";
        SetCoverage(data.CoverageRatio);
        StorageSummary.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("StorageSummary"), data.StoredFlows.ToString("N0"), FlowRow.FormatBytes(data.StorageBytes));
        MonitoringSince.Text = data.MonitoringStartedAt is { } started ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("MonitoringSince"), started.LocalDateTime.ToString("g")) : string.Empty;
        var coverageNote = data.CoverageRatio < 0.999999999
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("PartialCoverage"), Math.Min(data.CoverageRatio, 0.999))
            : string.Empty;
        var sleepNote = data.SleepSeconds > 0
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SleepCoverage"), FormatDuration(data.SleepSeconds))
            : string.Empty;
        // Said once, beside the totals it affects. A bare "+ N not measured"
        // tells someone a number is short without telling them whether to wait
        // for it, and the reason here is not the reason the Mac gives: on
        // Windows every observed flow carries its bytes, and the ones that do
        // not are the connections that were already open when monitoring began.
        var unmeasuredNote = data.ConnectionsWithoutBytes > 0
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("UnmeasuredReason"), data.ConnectionsWithoutBytes)
            : string.Empty;
        CoverageNote.Text = string.Join(Environment.NewLine,
            new[] { coverageNote, sleepNote, unmeasuredNote }.Where(value => value.Length > 0));
        var names = DestinationChoice.SelectedIndex == 0;
        FlowDiagram.SetItems(data.Links, IsByteMetric, names);
        Timeline.SetItems(data.Timeline, IsByteMetric, data.From, data.To, data.SleepPeriods, data.BucketCount, data.MonitoringGaps);
        DescribeCharts(data);
        SleepLegend.Visibility = data.SleepPeriods.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        // The legend says how much, because the band alone cannot: a gap
        // drawn at its minimum width looks the same whether it lasted ten
        // seconds or three minutes.
        MonitoringGapLegend.Visibility = data.MonitoringGaps.Count == 0 ? Visibility.Collapsed : Visibility.Visible;
        if (data.MonitoringGaps.Count > 0)
            MonitoringGapLegendText.Text = string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MonitoringGapLegend"), FormatDuration(data.MonitoringGapSeconds));
        FlowCaption.Text = IsByteMetric ? LocalizationManager.Text("RibbonBytes") : LocalizationManager.Text("RibbonConnections");
        TimelineCaption.Text = IsByteMetric ? LocalizationManager.Text("TimelineBytes") : LocalizationManager.Text("TimelineTotal");
        AutomationProperties.SetHelpText(FlowDiagram, FlowCaption.Text);
        AutomationProperties.SetHelpText(Timeline, TimelineCaption.Text);
    }

    /// Public because the render check asserts on it; it is a pure formatter.
    /// What to put where "cannot read state" goes.
    ///
    /// The pipe not answering has two meanings and the window used to show
    /// one of them. A service that is broken and a service that is two
    /// minutes into a schema migration look identical from here, and only
    /// one of them is worth doing something about.
    ///
    /// Read only on failure. While the Agent answers, what it says is better
    /// than a file beside its database.
    public static string UnavailableText(string fallback)
    {
        var progress = MigrationProgress.Read(
            MigrationProgress.ServiceDatabaseFrom(AppContext.BaseDirectory));
        if (progress is null) return fallback;
        return progress.Phase switch
        {
            MigrationProgress.BackingUp => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationBackingUp"), progress.ToVersion),
            MigrationProgress.MovingRows => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationMovingRows"), progress.ToVersion, progress.Rows),
            _ => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationInProgress"), progress.ToVersion),
        };
    }

    public static string FormatDuration(double seconds)
    {
        // Under a minute, say seconds.
        //
        // This used to floor at one minute, which was harmless while sleep was
        // the only caller -- nobody sleeps a PC for eleven seconds. Monitoring
        // gaps are routinely that short: a service restart is five seconds,
        // and two of them read as "1 minute", overstating by more than five
        // times.
        //
        // The band's width is already a deliberate overstatement, drawn at a
        // floor so a sub-pixel outage still reaches the screen. This legend is
        // what corrects for it, so it is the one place that has to be exact.
        if (seconds < 60)
            return string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DurationSeconds"),
                Math.Max(1, (int)Math.Round(seconds, MidpointRounding.AwayFromZero)));
        var minutes = (int)Math.Round(seconds / 60, MidpointRounding.AwayFromZero);
        return minutes >= 60
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DurationHoursMinutes"), minutes / 60, minutes % 60)
            : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DurationMinutes"), minutes);
    }

    private async Task RefreshInsightsAsync()
    {
        try
        {
            var current = currentAnalysis is not null && (currentAnalysis.To - currentAnalysis.From).TotalMinutes == selectedMinutes
                ? currentAnalysis : await ReadAnalysisAsync(selectedMinutes);
            var previousResponse = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "analysis", minutes = selectedMinutes, offsetMinutes = selectedMinutes }), lifetime.Token);
            using var previousDocument = JsonDocument.Parse(previousResponse);
            var previous = previousDocument.RootElement.GetProperty("data").Deserialize<PeriodAnalysis>();
            currentAnalysis = current;
            previousAnalysis = previous;
            InsightConnections.Text = current.Connections.ToString("N0");
            InsightApplications.Text = current.Applications.ToString("N0");
            InsightDestinations.Text = current.Destinations.ToString("N0");
            InsightBytes.Text = FlowRow.FormatBytes(current.Bytes);
            InsightConnectionsDelta.Text = InsightDelta(current.Connections, previous?.Connections ?? 0);
            InsightApplicationsDelta.Text = InsightDelta(current.Applications, previous?.Applications ?? 0);
            InsightDestinationsDelta.Text = InsightDelta(current.Destinations, previous?.Destinations ?? 0);
            InsightUnmeasured.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("InsightUnmeasuredFormat"), current.ConnectionsWithoutBytes);
            InsightChangeSummary.Text = InsightChangeSummaryText(current.Connections, previous?.Connections ?? 0);
            var applications = current.Links.GroupBy(link => link.Application, StringComparer.OrdinalIgnoreCase)
                .Select(group => new RankedRow(group.Key, group.Sum(link => link.Connections), false))
                .OrderByDescending(row => row.RawValue).ThenBy(row => row.Name, StringComparer.CurrentCultureIgnoreCase).Take(10).ToArray();
            var destinations = current.Links.GroupBy(link => link.DestinationName, StringComparer.OrdinalIgnoreCase)
                .Select(group => new RankedRow(group.Key, group.Sum(link => link.Connections), false))
                .OrderByDescending(row => row.RawValue).ThenBy(row => row.Name, StringComparer.CurrentCultureIgnoreCase).Take(10).ToArray();
            TopApplicationsList.ItemsSource = applications;
            TopDestinationsList.ItemsSource = destinations;
            InsightTopApp.Text = applications.FirstOrDefault() is { } topApp
                ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("InsightTopAppFormat"), topApp.Name, topApp.RawValue) : string.Empty;
            InsightTopDestination.Text = destinations.FirstOrDefault() is { } topDestination
                ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("InsightTopDestinationFormat"), topDestination.Name, topDestination.RawValue) : string.Empty;
            RefreshAiSurface();
        }
        catch (Exception exception) { InsightChangeSummary.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
    }

    internal static string InsightDelta(long current, long previous)
    {
        if (previous <= 0) return LocalizationManager.Text(current > 0 ? "NoPreviousData" : "InsightNoChange");
        var percent = (long)Math.Round((current - previous) * 100d / previous, MidpointRounding.AwayFromZero);
        return percent == 0 ? LocalizationManager.Text("InsightNoChangePrevious")
            : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("InsightDeltaFormat"), percent);
    }

    internal static string InsightChangeSummaryText(long current, long previous)
    {
        if (previous <= 0) return LocalizationManager.Text(current > 0 ? "InsightNoBaseline" : "InsightNoConnections");
        var percent = (long)Math.Round((current - previous) * 100d / previous, MidpointRounding.AwayFromZero);
        var key = Math.Abs(percent) < 10 ? "InsightStable" : percent > 0 ? "InsightIncreased" : "InsightDecreased";
        return string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text(key), key == "InsightDecreased" ? Math.Abs(percent) : percent);
    }

    private async Task RefreshThreatsAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "threats", minutes = selectedMinutes }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var report = document.RootElement.GetProperty("data").Deserialize<ThreatReport>() ?? throw new InvalidDataException();
            var selected = ThreatGrid.SelectedItem as ThreatRow;
            ThreatRows.Clear(); foreach (var finding in report.Findings) ThreatRows.Add(new(finding));
            if (selected is not null)
                ThreatGrid.SelectedItem = ThreatRows.FirstOrDefault(row => row.Address == selected.Address &&
                    row.IndicatorKind == selected.IndicatorKind && row.MatchedValue == selected.MatchedValue);
            var high = report.Findings.Where(item => item.Confidence == "high").Select(item => item.Destination).Distinct().Count();
            var low = report.Findings.Select(item => item.Destination).Distinct().Count() - high;
            ThreatCount.Text = report.Availability == "available" ? (high + low).ToString("N0") : "—";
            ThreatChecked.Text = report.CheckedDestinations.ToString("N0"); ThreatHigh.Text = high.ToString("N0"); ThreatLow.Text = low.ToString("N0");
            var fetched = report.FetchedAt is { } fetchedAt ? fetchedAt.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) : "—";
            ThreatContext.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ThreatContext"),
                report.IndicatorCount, fetched, PeriodChoice.SelectedItem is ComboBoxItem range ? range.Content : "—",
                report.DomainCheckedDestinations, report.DomainUncheckedDestinations);
            var status = report.Availability switch { "available" when report.Findings.Count == 0 => LocalizationManager.Text("NoThreatMatches"), "available" => string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ThreatMatches"), report.Findings.Count), "unavailable" => LocalizationManager.Text("HubNoThreatFeeds"), _ => LocalizationManager.Text("ThreatNotChecked") };
            ThreatStatus.Text = report.Availability == "available"
                ? $"{status} {string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DomainCoverage"), report.DomainCheckedDestinations, report.DomainUncheckedDestinations)}"
                : status;
            var showMatches = report.Availability == "available" && report.Findings.Count > 0;
            ThreatStatus.Visibility = showMatches ? Visibility.Visible : Visibility.Collapsed;
            ThreatEmptyNote.Visibility = showMatches ? Visibility.Collapsed : Visibility.Visible;
            ThreatTableCard.Visibility = showMatches ? Visibility.Visible : Visibility.Collapsed;
            ThreatDetailCard.Visibility = showMatches ? Visibility.Visible : Visibility.Collapsed;
            threatReadAt = DateTimeOffset.UtcNow;
        }
        catch
        {
            ThreatStatus.Text = LocalizationManager.Text("ThreatNotChecked"); ThreatCount.Text = "—";
            ThreatStatus.Visibility = Visibility.Collapsed;
            ThreatEmptyNote.Visibility = Visibility.Visible;
            ThreatTableCard.Visibility = Visibility.Collapsed;
            ThreatDetailCard.Visibility = Visibility.Collapsed;
        }
    }

    private void ThreatGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ThreatGrid.SelectedItem is not ThreatRow row)
        {
            ThreatDetail.Text = LocalizationManager.Text("SelectThreat");
            ThreatDetail.Visibility = Visibility.Visible;
            ThreatDetailFields.Visibility = Visibility.Collapsed;
            ThreatDetailFields.ItemsSource = null;
            return;
        }
        ThreatDetail.Visibility = Visibility.Collapsed;
        ThreatDetailFields.ItemsSource = new[]
        {
            new KeyValuePair<string, string>(LocalizationManager.Text("IpAddress"), row.Address),
            new KeyValuePair<string, string>(LocalizationManager.Text("ThreatRequestedName"), row.RequestedName),
            new KeyValuePair<string, string>(LocalizationManager.Text("Process"), row.Application),
            new KeyValuePair<string, string>(LocalizationManager.Text("ThreatIndicatorKind"), row.IndicatorKind),
            new KeyValuePair<string, string>(LocalizationManager.Text("MatchedValue"), row.MatchedValue),
            new KeyValuePair<string, string>(LocalizationManager.Text("Feed"), row.Feed),
            new KeyValuePair<string, string>(LocalizationManager.Text("Reason"), row.Reason),
            new KeyValuePair<string, string>(LocalizationManager.Text("Connections"), row.Connections),
            new KeyValuePair<string, string>(LocalizationManager.Text("DataVolume"), row.DataVolume),
            new KeyValuePair<string, string>(LocalizationManager.Text("FirstSeen"), row.FirstSeen),
            new KeyValuePair<string, string>(LocalizationManager.Text("LastSeen"), row.LastSeen),
        };
        ThreatDetailFields.Visibility = Visibility.Visible;
    }

    private void LogFilter_Changed(object sender, RoutedEventArgs e) { if (IsLoaded) ApplyLogFilter(); }

    /// True when one row is one observation rather than one conversation.
    private bool ObservationGrain => SelectedTag(LogGrain) == "observations";

    /// Switching the reading keeps the filters and the paused state: a switch
    /// that quietly resets the view is one nobody uses twice.
    private async void LogGrain_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        if (logPaused) { logPaused = false; logPausedAt = null; PauseLogButton.SetResourceReference(ContentProperty, "PauseUpdates"); }
        await RefreshFlowsAsync();
    }
    private void ApplyLogFilter()
    {
        var app = AppFilter.Text.Trim();
        var destination = DestinationFilter.Text.Trim();
        var port = PortFilter.Text.Trim();
        var country = SelectedTag(CountryFilter);
        var protocol = SelectedTag(ProtocolFilter);
        var volume = SelectedTag(VolumeFilter);
        var collector = SelectedTag(CollectorFilter);
        var from = DateTimeOffset.UtcNow.AddMinutes(-selectedMinutes);
        var filtered = rawFlows.Where(flow => flow.LastSeen >= from &&
            (app.Length == 0 || (flow.ProcessName?.Contains(app, StringComparison.CurrentCultureIgnoreCase) ?? false)) &&
            (destination.Length == 0 || flow.RemoteAddress.Contains(destination, StringComparison.OrdinalIgnoreCase) ||
                (flow.RemoteHostname?.Contains(destination, StringComparison.CurrentCultureIgnoreCase) ?? false)) &&
            (port.Length == 0 || flow.RemotePort.ToString(CultureInfo.InvariantCulture).Contains(port, StringComparison.Ordinal)) &&
            (country == "all" || (country == "unknown" ? string.IsNullOrWhiteSpace(flow.CountryCode) : string.Equals(flow.CountryCode, country, StringComparison.OrdinalIgnoreCase))) &&
            (protocol == "all" || flow.Protocol == protocol) &&
            (volume == "all" || (volume == "measured" ? flow.BytesSent is not null && flow.BytesReceived is not null : flow.BytesSent is null || flow.BytesReceived is null)) &&
            (collector == "all" || flow.Origin == collector)).ToArray();
        MergeRows(filtered.Select(flow => new FlowRow(flow, !ObservationGrain, rawFlowsReadAt)).ToArray());
        var active = new[] { app.Length > 0, destination.Length > 0, port.Length > 0, country != "all", protocol != "all", volume != "all", collector != "all" }.Count(value => value);
        LogStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("LogCountStatus"), filtered.Length, rawFlows.Count, active);
        // "Updated 20:41" alone does not say whether more will arrive. Paused
        // said so and following did not, so the two states read as one.
        if (!logPaused)
            LogStatus.Text += " · " + LocalizationManager.Text("LogFollowing")
                + " · " + string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("NetworkUpdatedAt"), rawFlowsReadAt.LocalDateTime.ToString("T", CultureInfo.CurrentCulture));
        if (logOmitted > 0)
            LogStatus.Text += " · " + string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("LogOmittedStatus"), logOmitted);
        if (logPaused && logPausedAt is { } heldAt)
            LogStatus.Text += " · " + string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("LogPausedStatus"), heldAt.LocalDateTime.ToString("g"));
        else if (ObservationGrain)
            LogStatus.Text += " · " + LocalizationManager.Text("LogGrainObservationsHint");
        else if (RecentFlows.Any(row => row.StateText.Length > 0))
            LogStatus.Text += " · " + string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("StillActiveHint"), (int)FlowRow.ActiveWindow.TotalSeconds);
    }

    private async void PauseLog_Click(object sender, RoutedEventArgs e)
    {
        logPaused = !logPaused;
        logPausedAt = logPaused ? DateTimeOffset.UtcNow : null;
        PauseLogButton.SetResourceReference(ContentProperty, logPaused ? "ResumeUpdates" : "PauseUpdates");
        ReconcileLogStream();
        if (logPaused) ApplyLogFilter();
        else await RefreshFlowsAsync();
    }

    /// Bring the visible list to the given rows without rebuilding it.
    ///
    /// Rows are matched by key: ones that are gone are removed, new ones are
    /// inserted where they belong, and ones that are still there are replaced
    /// only when something a reader can see has changed. What survives is the
    /// selection and the scroll position -- the two things that make a list
    /// possible to read while it updates underneath.
    private void MergeRows(IReadOnlyList<FlowRow> rows)
    {
        var selected = (ConnectionGrid.SelectedItem as FlowRow)?.Key;
        var incoming = rows.Select(row => row.Key).ToHashSet(StringComparer.Ordinal);
        for (var index = RecentFlows.Count - 1; index >= 0; index--)
            if (!incoming.Contains(RecentFlows[index].Key)) RecentFlows.RemoveAt(index);

        for (var index = 0; index < rows.Count; index++)
        {
            if (index >= RecentFlows.Count) { RecentFlows.Add(rows[index]); continue; }
            if (string.Equals(RecentFlows[index].Key, rows[index].Key, StringComparison.Ordinal))
            {
                // Same conversation, later numbers: a running flow changes its
                // end time and its bytes while keeping its identity.
                if (!RecentFlows[index].LooksSameAs(rows[index])) RecentFlows[index] = rows[index];
                continue;
            }
            RecentFlows.Insert(index, rows[index]);
        }
        while (RecentFlows.Count > rows.Count) RecentFlows.RemoveAt(RecentFlows.Count - 1);

        if (selected is null) return;
        var restored = RecentFlows.FirstOrDefault(row => string.Equals(row.Key, selected, StringComparison.Ordinal));
        if (restored is not null) ConnectionGrid.SelectedItem = restored;
    }

    private static string SelectedTag(System.Windows.Controls.ComboBox combo) => combo.SelectedItem is ComboBoxItem item ? item.Tag?.ToString() ?? "all" : "all";

    private void PopulateCountryFilter()
    {
        var selected = SelectedTag(CountryFilter);
        CountryFilter.Items.Clear();
        CountryFilter.Items.Add(new ComboBoxItem { Tag = "all", Content = LocalizationManager.Text("AllCountries") });
        foreach (var code in rawFlows.Select(flow => flow.CountryCode).Where(code => !string.IsNullOrWhiteSpace(code)).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(code => code))
            CountryFilter.Items.Add(new ComboBoxItem { Tag = code, Content = code });
        CountryFilter.Items.Add(new ComboBoxItem { Tag = "unknown", Content = LocalizationManager.Text("UnknownCountry") });
        CountryFilter.SelectedItem = CountryFilter.Items.Cast<ComboBoxItem>().FirstOrDefault(item => string.Equals(item.Tag?.ToString(), selected, StringComparison.OrdinalIgnoreCase)) ?? CountryFilter.Items[0];
    }

    private void ClearLogFilters_Click(object sender, RoutedEventArgs e)
    {
        AppFilter.Clear(); DestinationFilter.Clear(); PortFilter.Clear();
        CountryFilter.SelectedIndex = ProtocolFilter.SelectedIndex = VolumeFilter.SelectedIndex = CollectorFilter.SelectedIndex = 0;
        ApplyLogFilter();
    }

    private void GlobeViewChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        var countries = GlobeViewChoice.SelectedIndex == 1;
        Globe.Visibility = countries ? Visibility.Collapsed : Visibility.Visible;
        CountryHistoryPanel.Visibility = countries ? Visibility.Visible : Visibility.Collapsed;
        GlobeControls.Visibility = countries ? Visibility.Collapsed : Visibility.Visible;
        if (!loadingSettings) AgentSettings.GlobeView = countries ? "countries" : "globe";
    }

    private async void ExpandCountryAtlas_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var snapshot = await ReadLogSnapshotAsync(50, true, lifetime.Token);
            countryAtlasCursor = snapshot.Cursor;
            await RefreshCountryHistoryAsync();
            NetworkDashboard.Visibility = Visibility.Collapsed;
            ExpandedCountryAtlas.Visibility = Visibility.Visible;
            ReconcileCountryAtlasStream();
        }
        catch (Exception) { ExpandedCountryCount.Text = LocalizationManager.Text("CannotConnect"); }
    }

    private void CollapseCountryAtlas_Click(object sender, RoutedEventArgs e)
    {
        ExpandedCountryAtlas.Visibility = Visibility.Collapsed;
        NetworkDashboard.Visibility = Visibility.Visible;
        ReconcileCountryAtlasStream();
    }

    private async Task StreamCountryAtlasAsync()
    {
        if (countryAtlasStreaming || !countryAtlasTimer.IsEnabled) return;
        countryAtlasStreaming = true;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "log-delta", cursor = countryAtlasCursor, limit = LogStreamBatch }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var root = document.RootElement;
            if (root.GetProperty("status").GetString() != "ok") return;
            var events = root.GetProperty("data").Deserialize<List<RecentFlow>>() ?? [];
            countryAtlasCursor = root.GetProperty("cursor").GetInt64();
            var countries = events.Where(item => item.Layer == ObservationLayer.Logical &&
                !string.IsNullOrWhiteSpace(item.CountryCode) &&
                CountryGlow.Intensity(item.LastSeen, DateTimeOffset.UtcNow) > 0)
                .GroupBy(item => item.CountryCode!, StringComparer.OrdinalIgnoreCase)
                .Select(group => (Code: group.Key, At: group.Max(item => item.LastSeen))).ToArray();
            if (countries.Any(item => !allCountryCodes.Contains(item.Code)))
                await RefreshCountryHistoryAsync(); // Only new countries trigger the full all-time read.
            foreach (var (code, at) in countries) CountryMap.MarkActivity(code, at);
        }
        catch (Exception) { /* The normal network refresh reports persistent IPC errors. */ }
        finally { countryAtlasStreaming = false; }
    }

    private void ReconcileCountryAtlasStream()
    {
        var live = IsVisible && WindowState != WindowState.Minimized && MainTabs.SelectedIndex == 0 &&
            ExpandedCountryAtlas.Visibility == Visibility.Visible;
        if (live) countryAtlasTimer.Start(); else countryAtlasTimer.Stop();
    }

    private void SpinSpeedChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (SpinSpeedChoice.SelectedItem is not ListBoxItem item) return;
        var speed = item.Tag?.ToString() ?? "normal";
        Globe.DegreesPerSecond = speed switch { "slow" => 2, "fast" => 14, _ => 6 };
        if (!loadingSettings) AgentSettings.GlobeSpinSpeed = speed;
    }

    private async Task RefreshStatusAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"status"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var data = document.RootElement.GetProperty("data");
            var healthy = data.GetProperty("health").GetProperty("status").GetString() == "healthy";
            var monitoringEnabled = !data.TryGetProperty("monitoringEnabled", out var enabled) || enabled.GetBoolean();
            var health = data.GetProperty("health");
            var (issueCode, issueAction) = FirstHealthIssue(health);
            SetMonitoringState(healthy, monitoringEnabled, issueCode, issueAction);
            if (System.Windows.Application.Current is App trayApp) trayApp.UpdateTrayState(monitoringEnabled, healthy, issueCode, issueAction);
            loadingDeliveryState = true;
            // Remembered as well as applied: the settings tab is built the
            // first time it is shown, so the control does not exist yet when
            // the first status arrives, and a box left at its XAML default
            // would tell the person that name reading is off when it is on.
            readsHostnames = !data.TryGetProperty("readsHostnames", out var reads) || reads.GetBoolean();
            if (HostnameObservationEnabled is not null) HostnameObservationEnabled.IsChecked = readsHostnames;
            DeliveryEnabled.IsChecked = data.GetProperty("deliveryEnabled").GetBoolean();
            loadingDeliveryState = false;
            if (!healthy && System.Windows.Application.Current is App app)
                app.Notifications.Notify("Monitoring", "monitoring-health", "EgressView Agent", LocalizationManager.Text("NeedsAttention"), app.ShowNotification);
            AnnounceOutboundAnomaly(data);
            await RefreshDeliveryStatusAsync();
        }
        catch
        {
            var lastConfirmedAt = (System.Windows.Application.Current as App)?.MonitoringStatus.Current.LastConfirmedAt;
            SetMonitoringUnavailable(lastConfirmedAt);
            SetCoverage(null);
            if (System.Windows.Application.Current is App app) app.UpdateTrayUnavailable();
        }
    }

    private async Task RefreshDeliveryStatusAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"delivery-status"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var data = document.RootElement.GetProperty("data");
            var enrolled = data.GetProperty("enrolled").GetBoolean();
            var enabled = data.GetProperty("enabled").GetBoolean();
            var state = data.GetProperty("state").GetString() ?? "idle";
            HubDeliveryTarget.Text = enrolled && data.TryGetProperty("hub", out var hub) && hub.ValueKind == JsonValueKind.String
                ? hub.GetString() ?? LocalizationManager.Text("NotEnrolled") : LocalizationManager.Text("NotEnrolled");
            HubDeliveryState.Text = DeliveryStateText(state);
            var pending = data.GetProperty("pending").GetInt64();
            HubPending.Text = pending.ToString("N0", CultureInfo.CurrentCulture);
            HubLastAck.Text = DateText(data, "lastAcknowledgedAt");
            HubOldestPending.Text = $"{LocalizationManager.Text("OldestPending")}: {DateText(data, "oldestPendingAt")}";
            HubRetry.Text = $"{LocalizationManager.Text("NextRetry")}: {DateText(data, "nextRetryAt")}";
            var failure = data.TryGetProperty("lastFailure", out var failureValue) && failureValue.ValueKind == JsonValueKind.String
                ? DeliveryStateText(failureValue.GetString() ?? "") : "—";
            var statusCode = data.TryGetProperty("lastStatusCode", out var statusValue) && statusValue.ValueKind == JsonValueKind.Number
                ? $" (HTTP {statusValue.GetInt32()})" : string.Empty;
            HubLastFailure.Text = $"{LocalizationManager.Text("LastFailure")}: {failure}{statusCode}";
            SendNowButton.IsEnabled = enrolled && enabled && state != "sending";
            if (System.Windows.Application.Current is App app)
                app.Notifications.ObserveHubDelivery(new(DateTimeOffset.Now, enrolled && enabled, state, pending,
                    DateValue(data, "oldestPendingAt"), DateValue(data, "lastAcknowledgedAt")), app.ShowNotification);
        }
        catch
        {
            HubDeliveryState.Text = LocalizationManager.Text("CannotConnect");
            SendNowButton.IsEnabled = false;
        }
    }

    private static string DateText(JsonElement data, string property)
    {
        return DateValue(data, property)?.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) ?? "—";
    }

    private static DateTimeOffset? DateValue(JsonElement data, string property) =>
        data.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String &&
        DateTimeOffset.TryParse(value.GetString(), out var date) ? date : null;

    private static string DeliveryStateText(string state)
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        return state switch
        {
            "disabled" => ja ? "送信停止" : "Delivery off",
            "not-enrolled" => ja ? "未登録" : "Not enrolled",
            "sending" => ja ? "送信中" : "Sending",
            "up-to-date" => ja ? "送信済み" : "Up to date",
            "acknowledged" => ja ? "ACK受信" : "Acknowledged",
            "authorization-required" => ja ? "認証の更新が必要" : "Authorization required",
            "rate-limited" => ja ? "送信制限中" : "Rate limited",
            "retryable" => ja ? "一時失敗・再試行予定" : "Temporary failure; retry scheduled",
            "contract-rejected" => ja ? "Hub契約で拒否" : "Rejected by Hub contract",
            "invalid-acknowledgement" => ja ? "ACKを検証できません" : "Invalid acknowledgement",
            "hub-incompatible" => ja ? "Hub更新が必要" : "Hub update required",
            _ => ja ? "待機中" : "Idle",
        };
    }

    private static (string? Code, string? Action) FirstHealthIssue(JsonElement health)
    {
        if (!health.TryGetProperty("issues", out var issues) || issues.ValueKind != JsonValueKind.Array || issues.GetArrayLength() == 0)
            return (null, null);
        var first = issues[0];
        return (
            first.TryGetProperty("code", out var code) ? code.GetString() : null,
            first.TryGetProperty("action", out var action) ? action.GetString() : null);
    }

    /// The same action the tray menu offers, in the place people look first.
    ///
    /// It delegates rather than repeating the request, so the confirmation,
    /// the failure message and the refresh stay in one piece of code.
    private async void MonitoringSettingToggle_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is not App app) return;
        MonitoringSettingToggle.IsEnabled = false;
        try { await app.ToggleMonitoringFromSettingsAsync(); }
        finally { MonitoringSettingToggle.IsEnabled = true; }
    }

    /// Tells the person when their machine sent something unlike what it
    /// usually sends.
    ///
    /// The detector has no way to reach a person by itself: it runs in the
    /// service and writes a row. Without this, an anomaly was recorded, shown
    /// nowhere, and read by nobody -- the state P3-102 was already once in.
    ///
    /// Keyed on the window, so the same finding is announced once however
    /// often the status is polled, and a window seen before a restart is not
    /// announced again.
    private void AnnounceOutboundAnomaly(JsonElement data)
    {
        if (System.Windows.Application.Current is not App app) return;
        if (!data.TryGetProperty("outboundAnomaly", out var anomaly) || anomaly.ValueKind != JsonValueKind.Object) return;
        if (!anomaly.TryGetProperty("windowStart", out var startValue) ||
            !DateTimeOffset.TryParse(startValue.GetString(), out var windowStart)) return;
        if (windowStart <= AgentSettings.LastAnnouncedAnomalyAt) return;
        AgentSettings.LastAnnouncedAnomalyAt = windowStart;

        var distributed = anomaly.TryGetProperty("kind", out var kind) && kind.GetString() == "distributed-transfer";
        var bytes = anomaly.TryGetProperty("bytesOut", out var value) && value.TryGetUInt64(out var sent) ? sent : 0;
        var body = string.Format(CultureInfo.CurrentCulture,
            LocalizationManager.Text(distributed ? "OutboundAnomalyDistributedFormat" : "OutboundAnomalyLargeFormat"),
            windowStart.ToLocalTime().ToString("t", CultureInfo.CurrentCulture), FlowRow.FormatBytes((long)Math.Min(bytes, long.MaxValue)));
        app.Notifications.Notify("OutboundAnomaly", $"outbound-anomaly-{windowStart:O}", "EgressView Agent", body, app.ShowNotification);
    }

    /// Turning destination-name reading off is a request not to collect the
    /// names, so the service stops subscribing rather than collecting and
    /// discarding. That means restarting the trace session, which the wording
    /// beside the box says plainly.
    private async void HostnameObservationEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingDeliveryState || loadingSettings) return;
        var wanted = HostnameObservationEnabled.IsChecked == true;
        HostnameObservationEnabled.IsEnabled = false;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "set-hostname-observation", enabled = wanted }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            HostnameObservationStatus.Text = LocalizationManager.Text(wanted ? "ReadingNames" : "NotReadingNames");
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception)
        {
            HostnameObservationEnabled.IsChecked = !wanted;
            HostnameObservationStatus.Text = LocalizationManager.Text("CannotConnect");
        }
        finally { HostnameObservationEnabled.IsEnabled = true; }
    }

    private bool readsHostnames = true;

    private bool publicThreatFeeds;

    /// Turning this on lets this PC fetch the public lists itself.
    ///
    /// Off by default and asked for explicitly, because the fetch reveals that
    /// this PC asked -- not what it asked about, but that is still a fact
    /// about the person, and the wording beside the box says so.
    private async void PublicThreatFeedsEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingSettings) return;
        var wanted = PublicThreatFeedsEnabled.IsChecked == true;
        PublicThreatFeedsEnabled.IsEnabled = false;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "set-public-threat-feeds", enabled = wanted }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            publicThreatFeeds = wanted;
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { PublicThreatFeedsEnabled.IsChecked = !wanted; }
        finally { PublicThreatFeedsEnabled.IsEnabled = true; }
    }

    /// Reads the GeoIP.conf the MaxMind portal hands out.
    ///
    /// A file rather than two text boxes: the licence key is shown once, on a
    /// page you cannot revisit, and retyping forty characters from memory is
    /// where this goes wrong. The file is read here and passed straight to the
    /// service, which is what stores it; the window keeps no copy.
    private async void ChooseGeoIpConf_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Filter = "GeoIP.conf|GeoIP.conf;*.conf|" + LocalizationManager.Text("AllFiles") + "|*.*",
            FileName = "GeoIP.conf",
            CheckFileExists = true,
        };
        if (dialog.ShowDialog(this) != true) return;

        ChooseGeoIpConfButton.IsEnabled = false;
        try
        {
            string configuration;
            try { configuration = await File.ReadAllTextAsync(dialog.FileName, lifetime.Token); }
            catch (Exception)
            {
                CountryTableFailure.Text = LocalizationManager.Text("CannotReadFile");
                return;
            }
            await SendCountryTableAccountAsync(configuration);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        finally { ChooseGeoIpConfButton.IsEnabled = true; }
    }

    private async void RemoveCountryTable_Click(object sender, RoutedEventArgs e)
    {
        RemoveCountryTableButton.IsEnabled = false;
        try { await SendCountryTableAccountAsync(null); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        finally { RemoveCountryTableButton.IsEnabled = true; }
    }

    private async Task SendCountryTableAccountAsync(string? configuration)
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "set-country-table-account", configuration }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var root = document.RootElement;
            if (root.TryGetProperty("status", out var status) && status.GetString() == "rejected")
            {
                var reason = root.TryGetProperty("reason", out var value) ? value.GetString() : null;
                CountryTableFailure.Text = LocalizationManager.Text(
                    reason == "no-maxmind-account" ? "CountryTableNoAccount" : "CannotConnect");
                return;
            }
            EnsureAccepted(root);
            CountryTableFailure.Text = string.Empty;
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { CountryTableFailure.Text = LocalizationManager.Text("CannotConnect"); }
    }

    /// Says which of the two questions is unanswered: no account, or an
    /// account with no working table. One line for both would leave the reader
    /// unable to tell "you have not set this up" from "it is broken".
    private void RenderCountryTable(JsonElement item)
    {
        if (CountryTableStatus is null) return;
        var configured = item.TryGetProperty("configured", out var set) && set.GetBoolean();
        var table = item.TryGetProperty("table", out var kind) ? kind.GetString() ?? "absent" : "absent";
        var state = item.TryGetProperty("state", out var value) ? value.GetString() ?? "idle" : "idle";
        var enabled = item.TryGetProperty("enabled", out var on) && on.GetBoolean();
        var placed = item.TryGetProperty("placed", out var count) ? count.GetInt64() : 0;

        loadingSettings = true;
        try { CountryTableEnabled.IsChecked = enabled; }
        finally { loadingSettings = false; }

        CountryTableActions.Visibility = enabled ? Visibility.Visible : Visibility.Collapsed;
        RemoveCountryTableButton.IsEnabled = configured;
        FetchCountryTableButton.IsEnabled = configured && state != "fetching";

        var accountId = item.TryGetProperty("accountId", out var id) && id.ValueKind == JsonValueKind.String
            ? id.GetString() : null;
        CountryTableAccount.Text = !enabled ? string.Empty
            : string.IsNullOrEmpty(accountId)
                ? LocalizationManager.Text("NoMaxMindAccount")
                : string.Format(LocalizationManager.Text("UsingMaxMindAccount"), accountId);

        string status;
        if (!enabled || !configured) status = string.Empty;
        else if (state == "fetching") status = LocalizationManager.Text("CountryTableFetching");
        else status = table switch
        {
            "ready" => $"{string.Format(LocalizationManager.Text("TableBuilt"), DateText(item, "builtAt"))} " +
                       $"{LocalizationManager.Text("CountryTableExpires")}: {DateText(item, "expiresAt")}",
            "expired" => LocalizationManager.Text("CountryTableExpired"),
            "unreadable" => LocalizationManager.Text("CountryTableUnreadable"),
            _ => LocalizationManager.Text("NoTableYet"),
        };
        CountryTableStatus.Text = status;

        // Said as a sentence of its own, not folded into the status line:
        // whether the table answers anything is a different question from
        // whether it loaded, and it is the one that goes wrong quietly.
        CountryTablePlacedNote.Text = enabled && table == "ready"
            ? string.Format(LocalizationManager.Text("PlacedWithoutAsking"), placed) : string.Empty;

        var failure = item.TryGetProperty("lastFailure", out var reason) && reason.ValueKind == JsonValueKind.String
            ? reason.GetString() : null;
        CountryTableFailure.Text = state == "failed" && failure is not null ? failure : string.Empty;

        // The licence requires this wherever the data is shown.
        CountryTableAttribution.Text = enabled && item.TryGetProperty("attribution", out var credit)
            ? credit.GetString() ?? string.Empty : string.Empty;
    }

    /// Turning the table off leaves the account alone.
    ///
    /// Removing the account is a separate button, because someone switching
    /// the feature off for a week should not have to find their licence key
    /// again afterwards.
    private async void CountryTableEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingSettings) return;
        var wanted = CountryTableEnabled.IsChecked == true;
        CountryTableEnabled.IsEnabled = false;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "set-country-table-enabled", enabled = wanted }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { CountryTableEnabled.IsChecked = !wanted; }
        finally { CountryTableEnabled.IsEnabled = true; }
    }

    private async void FetchCountryTable_Click(object sender, RoutedEventArgs e)
    {
        FetchCountryTableButton.IsEnabled = false;
        try
        {
            await AgentIpcClient.RequestAsync("""{"v":1,"op":"refresh-enrichment","kind":"country"}""", lifetime.Token);
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { CountryTableFailure.Text = LocalizationManager.Text("CannotConnect"); }
        finally { FetchCountryTableButton.IsEnabled = true; }
    }

    /// One fetch now, which is not the same as agreeing to fetch from now on.
    private async void FetchPublicFeedsOnce_Click(object sender, RoutedEventArgs e)
    {
        FetchPublicFeedsOnceButton.IsEnabled = false;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                """{"v":1,"op":"fetch-public-feeds-once"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { ThreatEnrichmentFailure.Text = LocalizationManager.Text("CannotConnect"); }
        finally { FetchPublicFeedsOnceButton.IsEnabled = true; }
    }

    private void Hyperlink_RequestNavigate(object sender, System.Windows.Navigation.RequestNavigateEventArgs e)
    {
        try { Process.Start(new ProcessStartInfo(e.Uri.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception) { }
        e.Handled = true;
    }

    private void SetMonitoringState(bool healthy, bool enabled = true, string? issueCode = null, string? issueAction = null)
    {
        MonitoringStatus.Text = enabled ? LocalizationManager.Text(healthy ? "Monitoring" : "NeedsAttention") : LocalizationManager.Text("MonitoringStopped");
        var foreground = !enabled ? "TextSecondaryBrush" : healthy ? "SuccessBrush" : "ErrorBrush";
        var background = !enabled ? "SurfaceSecondaryBrush" : healthy ? "SuccessSoftBrush" : "ErrorSoftBrush";
        MonitoringStatus.Foreground = (System.Windows.Media.Brush)FindResource(foreground);
        MonitoringDot.Fill = MonitoringStatus.Foreground;
        MonitoringBadge.Background = (System.Windows.Media.Brush)FindResource(background);
        // The settings page shows the same state the badge and the tray show,
        // because there is only one. A second control with its own idea of
        // whether monitoring is on would eventually disagree with the first.
        if (MonitoringSettingState is not null)
        {
            MonitoringSettingState.Text = MonitoringStatus.Text;
            MonitoringSettingToggle.SetResourceReference(ContentProperty, enabled ? "StopMonitoring" : "StartMonitoring");
        }
        MonitoringBadge.ToolTip = !healthy && !string.IsNullOrWhiteSpace(issueCode)
            ? $"{issueCode}{(string.IsNullOrWhiteSpace(issueAction) ? string.Empty : $": {issueAction}")}" : null;
    }

    private void SetMonitoringUnavailable(DateTimeOffset? lastConfirmedAt)
    {
        MonitoringStatus.Text = lastConfirmedAt is { } confirmedAt
            ? $"{LocalizationManager.Text("StatusUnavailable")} · {string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("LastConfirmedFormat"), confirmedAt.ToLocalTime().ToString("g", CultureInfo.CurrentCulture))}"
            : LocalizationManager.Text("StatusUnavailable");
        MonitoringStatus.Foreground = (System.Windows.Media.Brush)FindResource("WarningBrush");
        MonitoringDot.Fill = MonitoringStatus.Foreground;
        MonitoringBadge.Background = (System.Windows.Media.Brush)FindResource("WarningSoftBrush");
        MonitoringBadge.ToolTip = lastConfirmedAt is { } at
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("LastConfirmedFormat"), at.ToLocalTime().ToString("g", CultureInfo.CurrentCulture))
            : LocalizationManager.Text("Checking");
    }

    /// The card widths, worked out from the height the way the Mac Agent
    /// works them out.
    ///
    /// The globe is drawn from the smaller side of its box, so a card much
    /// wider than it is tall spends the difference on nothing: it is given
    /// very nearly a square. The sankey keeps its name columns at a fixed
    /// width, so narrowing the card takes width off the ribbons and not off
    /// the names -- which is the point, the ribbons had more room than they
    /// needed once the names moved out of the canvas.
    ///
    /// Done here rather than in the XAML because both numbers depend on the
    /// height, and a star column cannot be told about one.
    private void DashboardGrid_SizeChanged(object sender, SizeChangedEventArgs e)
    {
        var width = Math.Max(1, DashboardGrid.ActualWidth);
        var topHeight = DashboardTopRow.ActualHeight;
        if (topHeight > 1)
            GlobeColumn.Width = new GridLength(Math.Min(topHeight + 14, width * 0.5));
        SankeyColumn.Width = new GridLength(Math.Min(Math.Max(width * 0.48, 336), Math.Max(340, width - 340)));
    }

    private void Rotate_Click(object sender, RoutedEventArgs e)
    {
        Globe.IsRotating = !Globe.IsRotating;
        RotateButton.SetResourceReference(ContentProperty, Globe.IsRotating ? "Stop" : "Rotate");
    }

    private async void RowLimit_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await RefreshFlowsAsync(); }
    private int SelectedLimit() => RowLimit.SelectedItem is ComboBoxItem item && int.TryParse(item.Content?.ToString(), out var value) ? value : 100;

    private static async Task<ObservationPage> ReadLogSnapshotAsync(int limit, bool events, CancellationToken cancellationToken = default)
    {
        var response = await AgentIpcClient.RequestAsync(
            JsonSerializer.Serialize(new { v = 1, op = "log-snapshot", limit, events }), cancellationToken);
        using var document = JsonDocument.Parse(response);
        var root = document.RootElement;
        return new(root.GetProperty("cursor").GetInt64(), root.GetProperty("more").GetBoolean(),
            root.GetProperty("data").Deserialize<List<RecentFlow>>() ?? []);
    }

    /// Advance the visible log by whatever has happened since it last looked.
    ///
    /// The stream carries observations, and the per-conversation reading is
    /// folded from those same observations by the store's own rule. One stream
    /// feeds both readings, so the two cannot disagree about what happened --
    /// only about how it is shown.
    private async Task StreamLogAsync()
    {
        if (logStreaming || logSnapshotReading || logPaused || !IsVisible || WindowState == WindowState.Minimized || MainTabs.SelectedIndex != 2) return;
        logStreaming = true;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "log-delta", cursor = logCursor, limit = LogStreamBatch }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var root = document.RootElement;
            if (root.GetProperty("status").GetString() != "ok") return;
            var events = root.GetProperty("data").Deserialize<List<RecentFlow>>() ?? [];
            logCursor = root.GetProperty("cursor").GetInt64();
            // A burst larger than one batch is not silently truncated: the
            // count of what was skipped is shown, and the next full read
            // restores the whole page.
            if (root.GetProperty("more").GetBoolean()) logOmitted += events.Count;
            if (events.Count == 0) return;

            var limit = SelectedLimit();
            rawFlows = ObservationGrain
                ? events.AsEnumerable().Reverse().Concat(rawFlows).Take(limit).ToArray()
                : ObservationFold.Apply(rawFlows, events, limit);
            rawFlowsReadAt = DateTimeOffset.UtcNow;
            ApplyLogFilter();
        }
        // Surface stream failure rather than silently leaving a stale table.
        // The five-second snapshot read can then reconcile when IPC recovers.
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
        finally { logStreaming = false; }
    }

    private void ReconcileLogStream()
    {
        var live = IsVisible && WindowState != WindowState.Minimized && !logPaused && MainTabs.SelectedIndex == 2;
        if (live) logStreamTimer.Start(); else logStreamTimer.Stop();
    }

    private static async Task<IReadOnlyList<RecentFlow>> ReadFlowPageAsync(int limit, int offset, CancellationToken cancellationToken = default) =>
        await ReadLogPageAsync("recent-flows", limit, offset, cancellationToken);

    private static async Task<IReadOnlyList<RecentFlow>> ReadLogPageAsync(string operation, int limit, int offset, CancellationToken cancellationToken = default)
    {
        var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = operation, limit, offset }), cancellationToken);
        using var document = JsonDocument.Parse(response);
        return document.RootElement.GetProperty("data").Deserialize<List<RecentFlow>>() ?? [];
    }

    private async void ExportCsv_Click(object sender, RoutedEventArgs e)
    {
        var now = DateTimeOffset.Now;
        var from = now.AddMinutes(-selectedMinutes);
        var dialog = new Microsoft.Win32.SaveFileDialog { Filter = "CSV (*.csv)|*.csv", FileName = ObservationCsv.SuggestedFileName(from, now), AddExtension = true };
        if (dialog.ShowDialog(this) != true) return;
        try
        {
            var export = new List<RecentFlow>();
            for (var offset = 0; offset <= 1_000_000; offset += 500)
            {
                var page = await ReadLogPageAsync(ObservationGrain ? "recent-observations" : "recent-flows", 500, offset, lifetime.Token);
                export.AddRange(page.Where(item => item.LastSeen >= from && item.LastSeen <= now));
                if (page.Count < 500 || page[^1].LastSeen < from) break;
            }
            await File.WriteAllTextAsync(dialog.FileName, ObservationCsv.Export(export), lifetime.Token);
            LogStatus.Text = $"{LocalizationManager.Text("CsvComplete")} {export.Count:N0} {LocalizationManager.Text("Rows").ToLower(CultureInfo.CurrentCulture)}";
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CsvFailed")} {exception.Message}"; }
    }

    private void LoadSettings()
    {
        loadingSettings = true;
        if (HostnameObservationEnabled is not null) HostnameObservationEnabled.IsChecked = readsHostnames;
        LanguageChoice.SelectedIndex = (int)AgentSettings.Language;
        NotificationsEnabled.IsChecked = AgentSettings.NotificationsEnabled;
        NotifyThreat.IsChecked = AgentSettings.NotificationCategoryEnabled("Threat");
        NotifyMonitoring.IsChecked = AgentSettings.NotificationCategoryEnabled("Monitoring");
        NotifyHubDelivery.IsChecked = AgentSettings.NotificationCategoryEnabled("HubDelivery");
        NotifyThreatIntel.IsChecked = AgentSettings.NotificationCategoryEnabled("ThreatIntel");
        NotifyRecovery.IsChecked = AgentSettings.NotificationCategoryEnabled("Recovery");
        NotifyOutboundAnomaly.IsChecked = AgentSettings.NotificationCategoryEnabled("OutboundAnomaly");
        DailyLimitChoice.SelectedIndex = AgentSettings.NotificationDailyLimit switch { 5 => 0, 25 => 2, 0 => 3, _ => 1 };
        FrameRateChoice.SelectedIndex = AgentSettings.GlobeFrameRate switch { 3 => 0, 15 => 2, _ => 1 };
        AutomaticUpdateChecks.IsChecked = AgentSettings.AutomaticUpdateChecks;
        StartupUiEnabled.IsChecked = AgentStartupRegistration.IsEnabled;
        selectedMinutes = AgentSettings.PeriodMinutes;
        PeriodChoice.SelectedItem = PeriodChoice.Items.OfType<ComboBoxItem>().First(item => item.Tag?.ToString() == selectedMinutes.ToString(CultureInfo.InvariantCulture));
        MetricChoice.SelectedIndex = AgentSettings.Metric == "bytes" ? 1 : 0;
        DestinationChoice.SelectedIndex = AgentSettings.DestinationUnit == "ip" ? 1 : 0;
        GlobeViewChoice.SelectedIndex = AgentSettings.GlobeView == "countries" ? 1 : 0;
        SpinSpeedChoice.SelectedIndex = AgentSettings.GlobeSpinSpeed switch { "slow" => 0, "fast" => 2, _ => 1 };
        SettingsSectionChoice.SelectedIndex = AgentSettings.SettingsSection switch { "notifications" => 1, "hub" => 2, "enrichment" => 3, "ai" => 4, "history" => 5, "diagnostics" => 6, "updates" => 7, "uninstall" => 8, "about" => 9, _ => 0 };
        DeleteHistoryBefore.SelectedDate = DateTime.Today.AddDays(-30);
        AiProviderChoice.SelectedIndex = AgentSettings.AiProvider switch { "OpenAI" => 1, "Anthropic" => 2, _ => 0 };
        AiEndpoint.Text = AgentSettings.OllamaEndpoint;
        AiCloudConsent.IsChecked = AgentSettings.AiCloudConsent(AgentSettings.AiProvider);
        PopulateAiModels();
        ShowAgentVersion();
        Globe.FramesPerSecond = AgentSettings.GlobeFrameRate;
        Globe.DegreesPerSecond = AgentSettings.GlobeSpinSpeed switch { "slow" => 2, "fast" => 16, _ => 6 };
        loadingSettings = false;
    }

    private void SettingsSectionChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (GeneralSettingsSection is null || NotificationSettingsSection is null || EnrichmentSettingsSection is null || AiSettingsSection is null || HistorySettingsSection is null || DiagnosticsSettingsSection is null || UpdateSettingsSection is null || HubSettingsSection is null || UninstallSettingsSection is null || AboutSettingsSection is null ||
            SettingsSectionChoice.SelectedItem is not ListBoxItem item) return;
        var section = item.Tag?.ToString() ?? "general";
        // Sections are built when first shown, so a control that was not
        // there for the last status has to be told the state now.
        if (section == "general" && HostnameObservationEnabled is not null)
            HostnameObservationEnabled.IsChecked = readsHostnames;
        if (section == "enrichment" && PublicThreatFeedsEnabled is not null)
            PublicThreatFeedsEnabled.IsChecked = publicThreatFeeds;
        GeneralSettingsSection.Visibility = section == "general" ? Visibility.Visible : Visibility.Collapsed;
        NotificationSettingsSection.Visibility = section == "notifications" ? Visibility.Visible : Visibility.Collapsed;
        EnrichmentSettingsSection.Visibility = section == "enrichment" ? Visibility.Visible : Visibility.Collapsed;
        AiSettingsSection.Visibility = section == "ai" ? Visibility.Visible : Visibility.Collapsed;
        HistorySettingsSection.Visibility = section == "history" ? Visibility.Visible : Visibility.Collapsed;
        DiagnosticsSettingsSection.Visibility = section == "diagnostics" ? Visibility.Visible : Visibility.Collapsed;
        UpdateSettingsSection.Visibility = section == "updates" ? Visibility.Visible : Visibility.Collapsed;
        HubSettingsSection.Visibility = section == "hub" ? Visibility.Visible : Visibility.Collapsed;
        UninstallSettingsSection.Visibility = section == "uninstall" ? Visibility.Visible : Visibility.Collapsed;
        AboutSettingsSection.Visibility = section == "about" ? Visibility.Visible : Visibility.Collapsed;
        if (!loadingSettings) AgentSettings.SettingsSection = section;
        if (section == "enrichment") _ = RefreshEnrichmentStatusAsync();
        if (section == "history") _ = RefreshHistoryStatusAsync();
        if (section == "updates") RefreshUpdateStatus();
    }

    internal void SelectSettingsSection(string section)
    {
        var match = SettingsSectionChoice.Items.OfType<ListBoxItem>().FirstOrDefault(item => item.Tag?.ToString() == section);
        if (match is not null) SettingsSectionChoice.SelectedItem = match;
    }

    internal void RefreshUpdateStatus()
    {
        if (System.Windows.Application.Current is not App app || InstalledVersion is null) return;
        var state = app.Updates.State;
        InstalledVersion.Text = state.CurrentVersion;
        AvailableVersion.Text = state.AvailableVersion ?? "—";
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        UpdateStatus.Text = state.Kind switch
        {
            UpdateStateKind.Checking => ja ? "更新情報を確認しています…" : "Checking release information…",
            UpdateStateKind.Downloading => ja ? "更新をダウンロードして検証しています…" : "Downloading and verifying the update…",
            UpdateStateKind.UpToDate => ja ? "最新です。" : "Up to date.",
            UpdateStateKind.Verified => ja ? "更新を検証しました。インストールできます。" : "The update is verified and ready to install.",
            UpdateStateKind.Launching => ja ? "Windows Installerを起動しています…" : "Starting Windows Installer…",
            UpdateStateKind.DownloadManually => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("UpdateDownloadManually"), state.AvailableVersion ?? "—"),
            UpdateStateKind.Failed => state.Detail switch
            {
                "verification-failed" => ja ? "署名またはSHA-256の検証に失敗しました。インストールしません。" : "Signature or SHA-256 verification failed. Nothing will be installed.",
                "network-error" => ja ? "更新サーバーへ接続できませんでした。監視は継続します。" : "Could not reach the update server. Monitoring continues.",
                _ => ja ? "更新情報を安全に検証できませんでした。" : "The release could not be validated safely.",
            },
            _ => ja ? "まだ更新を確認していません。" : "Updates have not been checked yet.",
        };
        var checkedText = state.CheckedAt?.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) ?? "—";
        UpdateVerification.Text = state.Publisher is { } publisher
            ? $"{(ja ? "発行元" : "Publisher")}: {publisher} · {state.Detail} · {(ja ? "最終確認" : "Last checked")}: {checkedText}"
            : $"{(ja ? "最終確認" : "Last checked")}: {checkedText}";
        CheckUpdateButton.IsEnabled = state.Kind is not UpdateStateKind.Checking and not UpdateStateKind.Downloading and not UpdateStateKind.Launching;
        InstallUpdateButton.IsEnabled = app.Updates.CanInstall;
        // Offered only when there is something to fetch. A button that opens a
        // page with nothing newer on it wastes the one action the reader has.
        OpenDownloadPageButton.Visibility = state.Kind == UpdateStateKind.DownloadManually
            ? Visibility.Visible : Visibility.Collapsed;
    }

    /// Opens the page the manifest was read from, not a address typed here.
    ///
    /// The origin is pinned to HTTPS in the update client, so this cannot be
    /// pointed somewhere else by anything the manifest says.
    private void OpenDownloadPage_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is not App app) return;
        try { Process.Start(new ProcessStartInfo(app.Updates.DownloadPage.AbsoluteUri) { UseShellExecute = true }); }
        catch (Exception) { }
    }

    private void AutomaticUpdateChecks_Click(object sender, RoutedEventArgs e)
    {
        if (!loadingSettings) AgentSettings.AutomaticUpdateChecks = AutomaticUpdateChecks.IsChecked == true;
    }

    private void StartupUiEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingSettings) return;
        try
        {
            AgentStartupRegistration.SetEnabled(StartupUiEnabled.IsChecked == true);
            PortableSettingsStatus.Text = LocalizationManager.Text("StartupSettingApplied");
        }
        catch (Exception exception)
        {
            StartupUiEnabled.IsChecked = AgentStartupRegistration.IsEnabled;
            PortableSettingsStatus.Text = $"{LocalizationManager.Text("SettingsOperationFailed")} Diagnostic: {exception.GetType().Name}";
        }
    }

    private async void ExportSettings_Click(object sender, RoutedEventArgs e)
    {
        try
        {
            var history = await ReadHistoryStatusAsync();
            var value = new AgentSettingsFile(AgentSettingsFile.CurrentSchemaVersion,
                AgentSettings.Language.ToString().ToLowerInvariant(), AgentSettings.NotificationsEnabled,
                AgentSettings.NotificationCategoryEnabled("Threat"), AgentSettings.NotificationCategoryEnabled("Monitoring"),
                AgentSettings.NotificationCategoryEnabled("HubDelivery"), AgentSettings.NotificationCategoryEnabled("ThreatIntel"),
                AgentSettings.NotificationCategoryEnabled("Recovery"), AgentSettings.NotificationDailyLimit, AgentSettings.GlobeFrameRate,
                AgentSettings.PeriodMinutes, AgentSettings.Metric, AgentSettings.DestinationUnit, AgentSettings.GlobeView,
                history.RetentionDays, AgentSettings.AutomaticUpdateChecks, AgentSettings.GlobeSpinSpeed);
            var dialog = new Microsoft.Win32.SaveFileDialog
            {
                Filter = "EgressView settings (*.json)|*.json",
                FileName = AgentSettingsFile.SuggestedFileName(DateTimeOffset.UtcNow),
                AddExtension = true,
                DefaultExt = ".json",
            };
            if (dialog.ShowDialog(this) != true) { PortableSettingsStatus.Text = LocalizationManager.Text("SettingsExportCancelled"); return; }
            await File.WriteAllBytesAsync(dialog.FileName, AgentSettingsFile.Encode(value), lifetime.Token);
            PortableSettingsStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SettingsExportedFormat"), dialog.FileName);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception) { PortableSettingsStatus.Text = $"{LocalizationManager.Text("SettingsOperationFailed")} Diagnostic: {exception.GetType().Name}"; }
    }

    private async void ImportSettings_Click(object sender, RoutedEventArgs e)
    {
        var dialog = new Microsoft.Win32.OpenFileDialog { Filter = "EgressView settings (*.json)|*.json", CheckFileExists = true, Multiselect = false };
        if (dialog.ShowDialog(this) != true) { PortableSettingsStatus.Text = LocalizationManager.Text("SettingsImportCancelled"); return; }
        try
        {
            var bytes = await File.ReadAllBytesAsync(dialog.FileName, lifetime.Token);
            var (value, ignored) = AgentSettingsFile.Read(bytes);
            var fields = AgentSettingsFile.PresentFields(value);
            var preview = string.Join("\r\n", fields.Select(field => $"• {field}: {PortableValue(value, field)}"));
            // Named before the file is applied, not after: someone deciding
            // whether to go ahead needs to know what will not travel.
            if (ignored.Count > 0)
                preview += Environment.NewLine + Environment.NewLine + string.Format(CultureInfo.CurrentCulture,
                    LocalizationManager.Text("SettingsImportIgnoredFormat"), string.Join(", ", ignored));
            var message = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SettingsImportPreviewFormat"), preview);
            if (System.Windows.MessageBox.Show(this, message, LocalizationManager.Text("ImportSettings"), MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK)
            { PortableSettingsStatus.Text = LocalizationManager.Text("SettingsImportCancelled"); return; }

            if (value.RetentionDays is { } retentionDays)
            {
                var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "set-history-retention", days = retentionDays }), lifetime.Token);
                using var responseDocument = JsonDocument.Parse(response);
                EnsureAccepted(responseDocument.RootElement);
            }
            ApplyPortableSettings(value);
            LoadSettings();
            LocalizationManager.Apply(System.Windows.Application.Current.Resources);
            ApplyAccessibilityLabels();
            PortableSettingsStatus.Text = ignored.Count == 0
                ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SettingsImportedFormat"), fields.Count)
                : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SettingsImportedWithIgnoredFormat"),
                    fields.Count, string.Join(", ", ignored));
            await RefreshAllAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            PortableSettingsStatus.Text = $"{LocalizationManager.Text("SettingsFileRejected")} Diagnostic: {exception.GetType().Name}";
        }
    }

    private static void ApplyPortableSettings(AgentSettingsFile value)
    {
        if (value.Language is { } language && Enum.TryParse<AgentLanguage>(language, true, out var parsedLanguage)) AgentSettings.Language = parsedLanguage;
        if (value.NotificationsEnabled is { } notifications) AgentSettings.NotificationsEnabled = notifications;
        if (value.NotifyThreat is { } threat) AgentSettings.SetNotificationCategory("Threat", threat);
        if (value.NotifyMonitoring is { } monitoring) AgentSettings.SetNotificationCategory("Monitoring", monitoring);
        if (value.NotifyHubDelivery is { } hubDelivery) AgentSettings.SetNotificationCategory("HubDelivery", hubDelivery);
        if (value.NotifyThreatIntel is { } threatIntel) AgentSettings.SetNotificationCategory("ThreatIntel", threatIntel);
        if (value.NotifyRecovery is { } recovery) AgentSettings.SetNotificationCategory("Recovery", recovery);
        if (value.NotificationDailyLimit is { } dailyLimit) AgentSettings.NotificationDailyLimit = dailyLimit;
        if (value.GlobeFrameRate is { } frameRate) AgentSettings.GlobeFrameRate = frameRate;
        if (value.PeriodMinutes is { } period) AgentSettings.PeriodMinutes = period;
        if (value.Metric is { } metric) AgentSettings.Metric = metric;
        if (value.DestinationUnit is { } destination) AgentSettings.DestinationUnit = destination;
        if (value.GlobeView is { } globeView) AgentSettings.GlobeView = globeView;
        if (value.GlobeSpinSpeed is { } spinSpeed) AgentSettings.GlobeSpinSpeed = spinSpeed;
        if (value.AutomaticUpdateChecks is { } updates) AgentSettings.AutomaticUpdateChecks = updates;
    }

    private static object? PortableValue(AgentSettingsFile value, string field) => field switch
    {
        nameof(AgentSettingsFile.Language) => value.Language,
        nameof(AgentSettingsFile.NotificationsEnabled) => value.NotificationsEnabled,
        nameof(AgentSettingsFile.NotifyThreat) => value.NotifyThreat,
        nameof(AgentSettingsFile.NotifyMonitoring) => value.NotifyMonitoring,
        nameof(AgentSettingsFile.NotifyHubDelivery) => value.NotifyHubDelivery,
        nameof(AgentSettingsFile.NotifyThreatIntel) => value.NotifyThreatIntel,
        nameof(AgentSettingsFile.NotifyRecovery) => value.NotifyRecovery,
        nameof(AgentSettingsFile.NotificationDailyLimit) => value.NotificationDailyLimit,
        nameof(AgentSettingsFile.GlobeFrameRate) => value.GlobeFrameRate,
        nameof(AgentSettingsFile.PeriodMinutes) => value.PeriodMinutes,
        nameof(AgentSettingsFile.Metric) => value.Metric,
        nameof(AgentSettingsFile.DestinationUnit) => value.DestinationUnit,
        nameof(AgentSettingsFile.GlobeView) => value.GlobeView,
        nameof(AgentSettingsFile.RetentionDays) => value.RetentionDays,
        nameof(AgentSettingsFile.AutomaticUpdateChecks) => value.AutomaticUpdateChecks,
        nameof(AgentSettingsFile.GlobeSpinSpeed) => value.GlobeSpinSpeed,
        _ => null,
    };

    private async Task<LocalHistoryStatus> ReadHistoryStatusAsync()
    {
        var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"history-status"}""", lifetime.Token);
        using var document = JsonDocument.Parse(response);
        EnsureAccepted(document.RootElement);
        return document.RootElement.GetProperty("data").Deserialize<LocalHistoryStatus>() ?? throw new InvalidDataException();
    }

    private async void PrepareUninstall_Click(object sender, RoutedEventArgs e)
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var delete = DeleteHistoryOnUninstall.IsChecked == true;
        var confirmation = delete
            ? (ja ? "監視を停止し、Hub登録・資格情報・送信待ちqueueと、このPCの全履歴を削除します。Hubが受理済みのデータは削除されません。続けますか？" : "Monitoring will stop. Hub registration, credentials, pending delivery queue, and all local history will be removed. Hub-accepted data is unaffected. Continue?")
            : (ja ? "監視を停止し、Hub登録・資格情報・送信待ちqueueを削除します。ローカル履歴とHubが受理済みのデータは残ります。続けますか？" : "Monitoring will stop. Hub registration, credentials, and pending delivery queue will be removed. Local history and Hub-accepted data remain. Continue?");
        if (System.Windows.MessageBox.Show(confirmation, LocalizationManager.Text("PrepareUninstall"), MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await PrepareUninstallAsync(continueWithoutRevocation: false);
    }

    private async void ContinueWithoutRevoke_Click(object sender, RoutedEventArgs e)
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        if (System.Windows.MessageBox.Show(ja ? "Hub登録は残ります。Hub管理者が手動で失効させる必要があります。それでも続けますか？" : "The Hub registration will remain and must be revoked manually by a Hub administrator. Continue anyway?",
            LocalizationManager.Text("ContinueWithoutRevoke"), MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;
        await PrepareUninstallAsync(continueWithoutRevocation: true);
    }

    private async Task PrepareUninstallAsync(bool continueWithoutRevocation)
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        PrepareUninstallButton.IsEnabled = ContinueWithoutRevokeButton.IsEnabled = false;
        UninstallStatus.Text = ja ? "監視と送信を停止し、Hub登録を失効しています…" : "Stopping monitoring and delivery, then revoking Hub registration…";
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new
            {
                v = 1,
                op = "prepare-uninstall",
                removeHistory = DeleteHistoryOnUninstall.IsChecked == true,
                continueWithoutRevocation,
            }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var root = document.RootElement;
            if (root.GetProperty("status").GetString() != "ok")
            {
                var reason = root.TryGetProperty("reason", out var value) ? value.GetString() : "uninstall-preparation-failed";
                var statusCode = root.TryGetProperty("statusCode", out var code) && code.ValueKind == JsonValueKind.Number ? $" (HTTP {code.GetInt32()})" : string.Empty;
                UninstallStatus.Text = (ja ? "Hub登録を失効できませんでした。監視／送信は停止したまま、資格情報と送信queueは残してあります。接続を確認して再試行するか、Hub管理者による手動失効を選んでください。" : "Hub registration could not be revoked. Monitoring and delivery remain paused; credentials and the delivery queue were preserved. Check the connection and retry, or choose manual Hub revocation.") + $"\r\nDiagnostic: {reason}{statusCode}";
                ContinueWithoutRevokeButton.Visibility = Visibility.Visible;
                return;
            }
            ContinueWithoutRevokeButton.Visibility = Visibility.Collapsed;
            UninstallStatus.Text = ja ? "アンインストール準備が完了しました。Windowsの「インストールされているアプリ」でEgressView Agentを選んでください。キャンセルした場合、Hubへ再登録するまで送信は再開しません。" : "Preparation is complete. Select EgressView Agent in Windows Installed apps. If you cancel, delivery will not resume until the Agent is enrolled again.";
            Process.Start(new ProcessStartInfo("ms-settings:appsfeatures-app") { UseShellExecute = true });
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception)
        {
            UninstallStatus.Text = (ja ? "Serviceへ接続できず、何も削除しませんでした。" : "The Service could not be reached; nothing was removed.") + $"\r\nDiagnostic: {exception.GetType().Name}";
        }
        finally { PrepareUninstallButton.IsEnabled = ContinueWithoutRevokeButton.IsEnabled = true; }
    }

    private async void CheckUpdate_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is App app) await app.Updates.CheckNowAsync(lifetime.Token);
    }

    private async void InstallUpdate_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is not App app) return;
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var message = ja
            ? "署名とSHA-256を再検証してWindows Installerを起動します。監視は一時停止し、完了後に再開します。続けますか？"
            : "The signature and SHA-256 will be verified again before Windows Installer starts. Monitoring pauses briefly and resumes after setup. Continue?";
        if (System.Windows.MessageBox.Show(message, "EgressView Agent", MessageBoxButton.OKCancel, MessageBoxImage.Question) == MessageBoxResult.OK)
            await app.Updates.LaunchInstallerAsync(lifetime.Token);
    }

    private async void SaveDiagnostics_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is not App app) return;
        SaveDiagnosticsButton.IsEnabled = false;
        DiagnosticsStatus.Text = LocalizationManager.Text("PreparingDiagnostics");
        try
        {
            var result = await app.SaveDiagnosticsAsync();
            DiagnosticsStatus.Text = result is null ? LocalizationManager.Text("DiagnosticsCancelled") :
                result.ServiceReportIncluded ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DiagnosticsSavedFormat"), result.Path) :
                string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DiagnosticsLimitedFormat"), result.Path);
        }
        finally { SaveDiagnosticsButton.IsEnabled = true; }
    }

    private void LanguageChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (loadingSettings || LanguageChoice.SelectedItem is not ComboBoxItem item || !Enum.TryParse<AgentLanguage>(item.Tag?.ToString(), out var language)) return;
        AgentSettings.Language = language;
        LocalizationManager.Apply(System.Windows.Application.Current.Resources);
        if (System.Windows.Application.Current is App app) app.RefreshTrayText();
        ApplyAccessibilityLabels();
        // The log's status line is composed in code, so it does not follow the
        // resource swap on its own.
        if (IsLoaded) ApplyLogFilter();
        _ = RefreshStatusAsync();
        RefreshNotifications();
    }

    private void ApplyAccessibilityLabels()
    {
        static void Name(FrameworkElement element, string key) => AutomationProperties.SetName(element, LocalizationManager.Text(key));
        Name(PeriodChoice, "Period");
        Name(LogGrain, "LogGrain");
        Name(PauseLogButton, logPaused ? "ResumeUpdates" : "PauseUpdates");
        Name(MetricChoice, "Measure");
        Name(DestinationChoice, "DestinationsBy");
        Name(GlobeViewChoice, "CommunicationDestinations");
        Name(Globe, "Globe");
        Name(CountryList, "DestinationCountries");
        Name(FlowDiagram, "WhichAppWhere");
        Name(Timeline, "WhenTraffic");
        Name(TopApplicationsList, "TopApplications");
        Name(TopDestinationsList, "TopDestinations");
        Name(AiConversation, "AiConversation");
        Name(AiQuestion, "AiQuestion");
        Name(AiPreview, "ExactPreview");
        Name(AppFilter, "Process");
        Name(DestinationFilter, "Destination");
        Name(PortFilter, "Port");
        Name(CountryFilter, "Country");
        Name(ProtocolFilter, "Protocol");
        Name(VolumeFilter, "DataVolume");
        Name(CollectorFilter, "Collector");
        Name(RowLimit, "Rows");
        Name(ConnectionGrid, "ConnectionLog");
        Name(ThreatGrid, "Threats");
        Name(NotificationList, "NotificationHistory");
        Name(EnrollmentCode, "EnrollmentCode");
        Name(LanguageChoice, "Language");
        Name(NotificationsEnabled, "NotificationsEnabled");
        Name(DailyLimitChoice, "DailyLimit");
        Name(FrameRateChoice, "GlobeFrameRate");
        Name(SettingsSectionChoice, "SettingsSections");
        Name(AiProviderChoice, "Provider");
        Name(AiModelChoice, "Model");
        Name(HistoryRetentionChoice, "KeepHistory");
        Name(SaveDiagnosticsButton, "SaveDiagnostics");
        Name(AutomaticUpdateChecks, "AutomaticUpdateChecks");
        Name(CheckUpdateButton, "CheckForUpdates");
        Name(InstallUpdateButton, "InstallVerifiedUpdate");
        Name(DeleteHistoryBefore, "DeleteBefore");
        Name(RefreshGeoButton, "FetchNow");
        Name(RefreshThreatButton, "RetryHub");
        AutomationProperties.SetName(HubUrl, "Hub URL");
        foreach (var status in new[] { MonitoringStatus, CoverageNote, LogStatus, ThreatStatus, NotificationSummary, EnrollmentStatus })
            AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
    }

    /// The build someone is actually running, on the screen they open to find
    /// out. It was only in the diagnostics bundle and the update section --
    /// neither of which is where a person looks to answer "which version is
    /// this?", and both of which are a worse place to be told.
    private void ShowAgentVersion()
    {
        if (AboutVersion is null) return;
        // The same number the update check compares against, read the same
        // way, so the screen cannot disagree with it.
        var version = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
        AboutVersion.Text = string.Format(LocalizationManager.Text("VersionFormat"), version);
    }

    private async Task RefreshEnrichmentStatusAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"enrichment-status"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var data = document.RootElement.GetProperty("data");
            var enrolled = data.GetProperty("enrolled").GetBoolean();
            var source = enrolled && data.TryGetProperty("source", out var sourceValue) && sourceValue.ValueKind == JsonValueKind.String
                ? sourceValue.GetString() : LocalizationManager.Text("NotEnrolled");
            EnrichmentSource.Text = $"{LocalizationManager.Text("ActiveSource")}: {source}";
            RenderEnrichment(data.GetProperty("geo"), GeoEnrichmentStatus, GeoEnrichmentFailure);
            RenderEnrichment(data.GetProperty("threat"), ThreatEnrichmentStatus, ThreatEnrichmentFailure);

            var countryTableOn = false;
            if (data.TryGetProperty("countryTable", out var countryTable))
            {
                RenderCountryTable(countryTable);
                countryTableOn = countryTable.TryGetProperty("enabled", out var on) && on.GetBoolean();
            }

            publicThreatFeeds = data.TryGetProperty("publicFeedsEnabled", out var feeds) && feeds.GetBoolean();
            if (PublicThreatFeedsEnabled is not null) PublicThreatFeedsEnabled.IsChecked = publicThreatFeeds;
            RenderEnrichmentPrivacy(publicThreatFeeds, countryTableOn,
                data.TryGetProperty("thirdPartyLookup", out var outside) && outside.GetBoolean());
            RenderThreatSource(data);
            RenderGeoLookupSource(data);

            // The Hub is what "retry" retries. Fetching once from the public
            // lists is its own button and does not need one.
            RefreshThreatButton.IsEnabled = enrolled;
            RefreshGeoButton.IsEnabled = enrolled;
        }
        catch
        {
            EnrichmentSource.Text = LocalizationManager.Text("CannotConnect");
            RefreshGeoButton.IsEnabled = RefreshThreatButton.IsEnabled = false;
        }
    }

    /// The three answers to "what should happen to an address the cache does
    /// not have", and what each one costs.
    ///
    /// The note under the choice is part of the choice, not decoration: one of
    /// these three sends watched destinations to a company neither the reader
    /// nor EgressView controls, and that sentence is the only place the screen
    /// says so.
    private void RenderGeoLookupSource(JsonElement data)
    {
        if (LookupHub is null) return;
        var source = data.TryGetProperty("lookupSource", out var value) ? value.GetString() ?? "hub" : "hub";
        var budget = data.TryGetProperty("thirdPartyBudget", out var total) ? total.GetInt64() : 0;
        var remaining = data.TryGetProperty("thirdPartyRemaining", out var left) ? left.GetInt64() : 0;

        loadingSettings = true;
        try
        {
            LookupCacheOnly.IsChecked = source == "cache-only";
            LookupHub.IsChecked = source == "hub";
            LookupHubThenThirdParty.IsChecked = source == "hub-then-third-party";
        }
        finally { loadingSettings = false; }

        GeoLookupSourceNote.Text = source switch
        {
            "cache-only" => LocalizationManager.Text("LookupCacheOnlyNote"),
            "hub-then-third-party" => string.Format(LocalizationManager.Text("LookupThirdPartyNote"), budget),
            _ => LocalizationManager.Text("LookupHubNote"),
        };
        // Only the third-party choice is a warning. Saying "nothing leaves
        // your network" in the same colour as "this sends addresses outside"
        // would make the colour mean nothing.
        GeoLookupSourceNote.Foreground = (System.Windows.Media.Brush)FindResource(
            source == "hub-then-third-party" ? "WarningBrush" : "TextSecondaryBrush");

        var placed = data.TryGetProperty("thirdPartyPlaced", out var bought) ? bought.GetInt64() : 0;
        // What the allowance bought, beside what is left of it. A number that
        // only counts down says how much was spent and never whether it
        // worked, and those are the two different ways this goes wrong.
        ThirdPartyBudgetNote.Text = source != "hub-then-third-party" ? string.Empty
            : (remaining > 0
                ? string.Format(LocalizationManager.Text("LookupsLeft"), remaining, budget)
                : string.Format(LocalizationManager.Text("LookupsUsedUp"), budget))
              + " " + string.Format(LocalizationManager.Text("LookupsPlaced"), placed);
    }

    private async void GeoLookupSource_Click(object sender, RoutedEventArgs e)
    {
        if (loadingSettings || sender is not System.Windows.Controls.RadioButton { Tag: string source }) return;
        try
        {
            var response = await AgentIpcClient.RequestAsync(
                JsonSerializer.Serialize(new { v = 1, op = "set-geo-lookup-source", source }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception) { GeoEnrichmentFailure.Text = LocalizationManager.Text("CannotConnect"); }
    }

    /// Where the threat information in use right now actually came from.
    ///
    /// A count and a timestamp do not say this, and the difference matters:
    /// indicators from a saved cache, from the Hub, and from the public lists
    /// after the Hub could not be reached are three different situations that
    /// otherwise look identical on this screen.
    private void RenderThreatSource(JsonElement data)
    {
        if (ThreatSource is null) return;
        var source = data.TryGetProperty("threat", out var threat)
            && threat.TryGetProperty("source", out var value) ? value.GetString() : null;
        ThreatSource.Text = LocalizationManager.Text(source switch
        {
            "hub" => "CurrentSourceHub",
            "public-feeds" => "CurrentSourcePublic",
            "public-feeds-fallback" => "CurrentSourcePublicFallback",
            "cache" => "CurrentSourceCache",
            _ => "CurrentSourceNone",
        });
    }

    /// Says what this PC contacts directly, because sometimes it does.
    ///
    /// The line above this used to read "Hub only" whatever the settings said.
    /// Turning on the public feeds, or setting a MaxMind account, makes this
    /// Agent fetch from abuse.ch, Spamhaus or MaxMind itself -- and a privacy
    /// note that stays the same while the behaviour changes underneath it is
    /// worse than none, because it is the line a reader would rely on.
    private void RenderEnrichmentPrivacy(bool publicFeeds, bool countryTable, bool thirdPartyLookup = false)
    {
        // Remembered because the globe's caption makes the same claim from
        // the other side of the window, and the two disagreeing is the defect
        // this pair of lines exists to stop.
        enrichmentThirdParty = thirdPartyLookup;
        enrichmentPublicFeeds = publicFeeds;
        enrichmentCountryTable = countryTable;
        if (EnrichmentPrivacyNote is null) return;
        var claim = EnrichmentDisclosure.Describe(thirdPartyLookup, publicFeeds, countryTable,
            LocalizationManager.Text("SourceIpwho"), LocalizationManager.Text("SourcePublicFeeds"),
            LocalizationManager.Text("SourceMaxMind"));
        EnrichmentPrivacyNote.Text = claim.Sources.Count == 0
            ? LocalizationManager.Text(claim.Key)
            : string.Format(LocalizationManager.Text(claim.Key), string.Join(" / ", claim.Sources));
    }

    private bool enrichmentThirdParty;
    private bool enrichmentPublicFeeds;
    private bool enrichmentCountryTable;

    /// What to say when the globe has nothing to show.
    ///
    /// It used to say "connect to a Hub" and "no external map or location
    /// service is contacted by this app" -- the first when there are now two
    /// ways to place an address without a Hub, and the second while the
    /// settings screen was already qualifying the very same claim. The screen
    /// that makes a promise and the screen that qualifies it have to be the
    /// same screen.
    private string GlobeUnavailableText()
    {
        var claim = EnrichmentDisclosure.Describe(enrichmentThirdParty, enrichmentPublicFeeds,
            enrichmentCountryTable, LocalizationManager.Text("SourceIpwho"),
            LocalizationManager.Text("SourcePublicFeeds"), LocalizationManager.Text("SourceMaxMind"));
        return claim.Sources.Count == 0
            ? LocalizationManager.Text("GlobeUnavailable")
            : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("GlobeUnavailableDirect"),
                string.Join(" / ", claim.Sources));
    }

    private static void RenderEnrichment(JsonElement item, TextBlock status, TextBlock failure)
    {
        var state = item.GetProperty("state").GetString() ?? "idle";
        var freshness = item.GetProperty("freshness").GetString() ?? "not-fetched";
        var count = item.GetProperty("count").GetInt64();
        status.Text = $"{LocalizationManager.Text("LastSuccess")}: {DateText(item, "lastSuccessAt")} · {LocalizationManager.Text("Items")}: {count:N0} · {EnrichmentStateText(state, freshness)}";
        failure.Text = item.TryGetProperty("lastFailure", out var value) && value.ValueKind == JsonValueKind.String
            ? $"{LocalizationManager.Text("LastFailure")}: {value.GetString()}" : string.Empty;
    }

    private static string EnrichmentStateText(string state, string freshness)
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        if (state == "fetching") return ja ? "取得中" : "Fetching";
        if (state == "queued") return ja ? "取得待ち" : "Queued";
        if (state == "not-enrolled") return ja ? "Hub未登録" : "Not enrolled";
        if (state == "failed") return ja ? "取得失敗" : "Fetch failed";
        return freshness switch { "current" => ja ? "最新" : "Current", "stale" => ja ? "期限切れ" : "Stale", _ => ja ? "未取得" : "Not fetched" };
    }

    private async void RefreshGeo_Click(object sender, RoutedEventArgs e) => await RequestEnrichmentAsync("geo");
    private async void RefreshThreat_Click(object sender, RoutedEventArgs e) => await RequestEnrichmentAsync("threat");

    private async Task RequestEnrichmentAsync(string kind)
    {
        RefreshGeoButton.IsEnabled = RefreshThreatButton.IsEnabled = false;
        try
        {
            await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "refresh-enrichment", kind }), lifetime.Token);
            await Task.Delay(500, lifetime.Token);
            await RefreshEnrichmentStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch { await RefreshEnrichmentStatusAsync(); }
    }

    private void NotificationSettings_Changed(object sender, RoutedEventArgs e)
    {
        if (loadingSettings) return;
        AgentSettings.NotificationsEnabled = NotificationsEnabled.IsChecked == true;
        foreach (var box in new[] { NotifyThreat, NotifyMonitoring, NotifyHubDelivery, NotifyThreatIntel, NotifyRecovery, NotifyOutboundAnomaly })
            if (box.Tag is string kind) AgentSettings.SetNotificationCategory(kind, box.IsChecked == true);
        if (DailyLimitChoice.SelectedItem is ComboBoxItem item && int.TryParse(item.Tag?.ToString(), out var value)) AgentSettings.NotificationDailyLimit = value;
        RefreshNotifications();
    }

    private void FrameRateChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (loadingSettings || FrameRateChoice.SelectedItem is not ComboBoxItem item || !int.TryParse(item.Tag?.ToString(), out var value)) return;
        AgentSettings.GlobeFrameRate = value; Globe.FramesPerSecond = value;
    }

    private void SendTestNotification_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is not App app) return;
        app.Notifications.Notify("Monitoring", Guid.NewGuid().ToString(), "EgressView Agent", LocalizationManager.Text("Monitoring"), app.ShowNotification, true);
        RefreshNotifications();
    }

    private void ClearNotifications_Click(object sender, RoutedEventArgs e) { if (System.Windows.Application.Current is App app) app.Notifications.Clear(); RefreshNotifications(); }
    private void RefreshNotifications()
    {
        if (System.Windows.Application.Current is not App app) return;
        NotificationPermission.Text = AgentSettings.NotificationsEnabled ? LocalizationManager.Text("NotificationPermissionOn") : LocalizationManager.Text("NotificationPermissionOff");
        NotificationSummary.Text = $"{LocalizationManager.Text("AttemptsToday")}: {app.Notifications.AttemptsToday:N0} · {LocalizationManager.Text("NotificationsToday")}: {app.Notifications.SentToday:N0} · {LocalizationManager.Text("SuppressedToday")}: {app.Notifications.SuppressedToday:N0}";
        NotificationSentToday.Text = app.Notifications.SentToday.ToString("N0", CultureInfo.CurrentCulture);
        NotificationSuppressedToday.Text = app.Notifications.History.Count(item =>
            item.Date.LocalDateTime.Date == DateTime.Today && item.Outcome == "suppressed-daily-limit").ToString("N0", CultureInfo.CurrentCulture);
        NotificationPermissionCard.Text = AgentSettings.NotificationsEnabled
            ? LocalizationManager.Text("NotificationPermissionOn") : LocalizationManager.Text("NotificationPermissionOff");
        NotificationEmptyNote.Visibility = app.Notifications.History.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
        NotificationList.ItemsSource = app.Notifications.History.Select(item => new NotificationRow(item)).ToArray();
    }

    private async Task RefreshHistoryStatusAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"history-status"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            RenderHistoryStatus(document.RootElement.GetProperty("data").Deserialize<LocalHistoryStatus>() ?? throw new InvalidDataException());
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception) { HistoryOperationStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
    }

    private void RenderHistoryStatus(LocalHistoryStatus status)
    {
        loadingHistorySettings = true;
        HistoryRetentionChoice.SelectedIndex = status.RetentionDays switch { 1 => 0, 7 => 1, 90 => 3, _ => 2 };
        loadingHistorySettings = false;
        historyOldestRaw = status.OldestRawAt;
        HistoryRetentionPolicy.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("RawHistoryPolicy"), status.RawDays, status.RetentionDays);
        HistoryDiskUsage.Text = FlowRow.FormatBytes(status.StorageBytes);
        HistoryNextCleanup.Text = status.NextCleanupAt.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);
        var raw = status.OldestRawAt?.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) ?? "—";
        var aggregate = status.OldestAggregateAt?.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) ?? "—";
        var last = status.LastCleanupAt?.ToLocalTime().ToString("g", CultureInfo.CurrentCulture) ?? LocalizationManager.Text("NotYet");
        HistoryStoredRange.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("HistoryStoredRangeFormat"), raw, aggregate, last);
    }

    private async void HistoryRetentionChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || loadingSettings || loadingHistorySettings || HistoryRetentionChoice.SelectedItem is not ComboBoxItem item ||
            !int.TryParse(item.Tag?.ToString(), out var days)) return;
        SetHistoryBusy(true);
        HistoryOperationStatus.Text = LocalizationManager.Text("ApplyingRetention");
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "set-history-retention", days }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            RenderHistoryStatus(document.RootElement.GetProperty("data").Deserialize<LocalHistoryStatus>() ?? throw new InvalidDataException());
            HistoryOperationStatus.Text = LocalizationManager.Text("RetentionApplied");
            await RefreshAllAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception) { HistoryOperationStatus.Text = $"{LocalizationManager.Text("HistoryOperationFailed")} {exception.Message}"; await RefreshHistoryStatusAsync(); }
        finally { SetHistoryBusy(false); }
    }

    private async void DeleteHistoryBefore_Click(object sender, RoutedEventArgs e)
    {
        if (DeleteHistoryBefore.SelectedDate is not { } date) return;
        var cutoff = new DateTimeOffset(date.Date, TimeZoneInfo.Local.GetUtcOffset(date.Date));
        await ConfirmAndDeleteHistoryAsync(cutoff);
    }

    private async void DeleteAllHistory_Click(object sender, RoutedEventArgs e) => await ConfirmAndDeleteHistoryAsync(null);

    private async Task ConfirmAndDeleteHistoryAsync(DateTimeOffset? cutoff)
    {
        var prompt = cutoff is null ? LocalizationManager.Text("ConfirmDeleteAllHistory") : LocalizationManager.Text("ConfirmDeleteBeforeHistory");
        var choice = System.Windows.MessageBox.Show(this, prompt, LocalizationManager.Text("DeleteHistory"), MessageBoxButton.YesNoCancel, MessageBoxImage.Warning);
        if (choice == MessageBoxResult.Cancel) return;
        SetHistoryBusy(true);
        try
        {
            if (choice == MessageBoxResult.Yes && !await ExportHistoryAsync(cutoff)) return;
            HistoryOperationStatus.Text = LocalizationManager.Text("DeletingHistory");
            var request = cutoff is null
                ? JsonSerializer.Serialize(new { v = 1, op = "delete-history", scope = "all" })
                : JsonSerializer.Serialize(new { v = 1, op = "delete-history", scope = "before", before = cutoff.Value.ToUniversalTime() });
            var response = await AgentIpcClient.RequestAsync(request, lifetime.Token);
            using var document = JsonDocument.Parse(response);
            EnsureAccepted(document.RootElement);
            var result = document.RootElement.GetProperty("data").Deserialize<LocalHistoryDeletionResult>() ?? throw new InvalidDataException();
            HistoryOperationStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("HistoryDeleted"), result.TotalDeleted);
            await RefreshAllAsync();
            await RefreshHistoryStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception exception) { HistoryOperationStatus.Text = $"{LocalizationManager.Text("HistoryOperationFailed")} {exception.Message}"; }
        finally { SetHistoryBusy(false); }
    }

    private async Task<bool> ExportHistoryAsync(DateTimeOffset? cutoff)
    {
        var end = cutoff ?? DateTimeOffset.Now;
        var start = historyOldestRaw ?? end;
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = LocalizationManager.Text("SaveCopyBeforeDeleting"),
            Filter = "CSV (*.csv)|*.csv",
            FileName = ObservationCsv.SuggestedFileName(start, end),
            AddExtension = true,
        };
        if (dialog.ShowDialog(this) != true) return false;
        var temporary = $"{dialog.FileName}.tmp-{Guid.NewGuid():N}";
        try
        {
            await using (var writer = new StreamWriter(temporary, false, new System.Text.UTF8Encoding(false)))
            {
                await writer.WriteAsync(ObservationCsv.Header);
                var total = 0;
                for (var offset = 0; offset <= 10_000_000; offset += 500)
                {
                    var page = await ReadHistoryExportPageAsync(cutoff, 500, offset);
                    await writer.WriteAsync(ObservationCsv.ExportRows(page));
                    total += page.Count;
                    HistoryOperationStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SavingHistory"), total);
                    if (page.Count < 500) break;
                }
                await writer.FlushAsync(lifetime.Token);
            }
            File.Move(temporary, dialog.FileName, true);
            return true;
        }
        catch (Exception exception)
        {
            try { File.Delete(temporary); } catch { }
            HistoryOperationStatus.Text = $"{LocalizationManager.Text("CsvFailed")} {exception.Message}";
            return false;
        }
    }

    private static void EnsureAccepted(JsonElement root)
    {
        if (root.TryGetProperty("status", out var status) && status.GetString() == "ok") return;
        var reason = root.TryGetProperty("reason", out var value) ? value.GetString() : "unknown";
        throw new InvalidOperationException(reason);
    }

    private async Task<IReadOnlyList<RecentFlow>> ReadHistoryExportPageAsync(DateTimeOffset? cutoff, int limit, int offset)
    {
        var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "history-export", before = cutoff?.ToUniversalTime(), limit, offset }), lifetime.Token);
        using var document = JsonDocument.Parse(response);
        EnsureAccepted(document.RootElement);
        return document.RootElement.GetProperty("data").Deserialize<List<RecentFlow>>() ?? [];
    }

    private void SetHistoryBusy(bool busy)
    {
        HistoryRetentionChoice.IsEnabled = !busy;
        DeleteHistoryBeforeButton.IsEnabled = !busy;
        DeleteAllHistoryButton.IsEnabled = !busy;
    }

    private AiProviderKind SelectedAiProvider() => AiProviderChoice.SelectedItem is ComboBoxItem item &&
        Enum.TryParse<AiProviderKind>(item.Tag?.ToString(), out var provider) ? provider : AiProviderKind.Ollama;

    private string SelectedAiModel() => (AiModelChoice.Text ?? string.Empty).Trim();

    private void AiProviderChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (AiModelChoice is null || AiEndpoint is null || AiApiKey is null || AiCloudConsent is null) return;
        PopulateAiModels();
        var local = SelectedAiProvider() == AiProviderKind.Ollama;
        AiEndpoint.IsEnabled = local;
        AiApiKey.IsEnabled = AiCloudConsent.IsEnabled = !local;
        AiCloudConsent.IsChecked = AgentSettings.AiCloudConsent(SelectedAiProvider().ToString());
        if (!loadingSettings && !AgentSettings.AiEnabled(SelectedAiProvider().ToString())) AiSettingsStatus.Text = LocalizationManager.Text("SaveTestRequired");
        RefreshAiSurface();
    }

    private void PopulateAiModels()
    {
        if (AiModelChoice is null) return;
        var provider = SelectedAiProvider();
        var saved = AgentSettings.AiModel(provider.ToString());
        var models = provider switch
        {
            AiProviderKind.OpenAI => AgentAiClient.OpenAiModels,
            AiProviderKind.Anthropic => AgentAiClient.AnthropicModels,
            _ => Array.Empty<string>(),
        };
        AiModelChoice.ItemsSource = models;
        // Still typable for Ollama: a model can be pulled while this window is
        // open, and refusing a name the list has not caught up with would be
        // worse than accepting one that turns out not to exist -- the save
        // button checks it either way.
        AiModelChoice.IsEditable = provider == AiProviderKind.Ollama;
        AiModelChoice.Text = saved.Length > 0 ? saved : models.FirstOrDefault() ?? string.Empty;
        if (provider != AiProviderKind.Ollama) return;
        lastOllamaEndpointLoaded = (AiEndpoint?.Text ?? string.Empty).Trim();
        _ = LoadOllamaModelsAsync(saved);
    }

    /// Fills the list with what this PC actually has.
    ///
    /// Until now the box was empty and editable, so using it correctly meant
    /// typing "qwen:latest" -- tag and all -- from memory, and a name one
    /// character out failed the connection test with nothing to compare it
    /// against. The names are on the machine; asking for them is one request
    /// to a loopback address.
    private async Task LoadOllamaModelsAsync(string preferred)
    {
        var endpoint = (AiEndpoint?.Text ?? string.Empty).Trim();
        if (endpoint.Length == 0) return;
        var generation = ++ollamaModelGeneration;
        try
        {
            var models = await aiClient.ListOllamaModelsAsync(endpoint, lifetime.Token);
            // A slower earlier request must not overwrite a newer answer, for
            // example after the endpoint was edited twice.
            if (generation != ollamaModelGeneration || SelectedAiProvider() != AiProviderKind.Ollama) return;
            // Whatever is in the box wins over the saved setting. Clicking the
            // model list takes focus off the endpoint, which reloads the list;
            // preferring the saved value here put the old model back the
            // instant a new one was chosen.
            //
            // Read before ItemsSource is assigned, because assigning it clears
            // the text of an editable box.
            var chosen = (AiModelChoice.Text ?? string.Empty).Trim();
            if (chosen.Length == 0) chosen = preferred;
            // Replacing the list with an identical one is not harmless: the
            // items become different objects, and if the drop-down is open --
            // which it is, because opening it is what took focus off the
            // endpoint and started this reload -- the item the person is
            // reaching for is swapped out from under the click.
            var unchanged = AiModelChoice.ItemsSource is IEnumerable<string> existing && existing.SequenceEqual(models);
            if (!unchanged && !AiModelChoice.IsDropDownOpen)
            {
                AiModelChoice.ItemsSource = models;
                AiModelChoice.Text = chosen.Length > 0 ? chosen : models.FirstOrDefault() ?? string.Empty;
            }
            if (models.Count == 0) AiSettingsStatus.Text = LocalizationManager.Text("OllamaNoModels");
            else if (!AgentSettings.AiEnabled(AiProviderKind.Ollama.ToString()))
                AiSettingsStatus.Text = string.Format(LocalizationManager.Text("OllamaModelsFound"), models.Count);
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (Exception)
        {
            if (generation != ollamaModelGeneration || SelectedAiProvider() != AiProviderKind.Ollama) return;
            // Said plainly, because an empty list from an Ollama that is not
            // running looks exactly like an Ollama with nothing installed.
            AiSettingsStatus.Text = LocalizationManager.Text("OllamaUnreachable");
        }
    }

    private int ollamaModelGeneration;

    /// The endpoint is the address the list comes from, so changing it changes
    /// the list. Leaving the box without changing it changes nothing, and
    /// reloading anyway is work that can only do harm: clicking the model
    /// drop-down is what takes focus off this box.
    private string lastOllamaEndpointLoaded = string.Empty;

    private void AiEndpoint_LostKeyboardFocus(object sender, System.Windows.Input.KeyboardFocusChangedEventArgs e)
    {
        InvalidateSelectedAiConfiguration();
        if (loadingSettings || SelectedAiProvider() != AiProviderKind.Ollama) return;
        var endpoint = (AiEndpoint.Text ?? string.Empty).Trim();
        if (string.Equals(endpoint, lastOllamaEndpointLoaded, StringComparison.Ordinal)) return;
        lastOllamaEndpointLoaded = endpoint;
        _ = LoadOllamaModelsAsync(AgentSettings.AiModel(AiProviderKind.Ollama.ToString()));
    }

    private void InvalidateSelectedAiConfiguration()
    {
        if (loadingSettings || AiProviderChoice is null) return;
        AgentSettings.SetAiEnabled(SelectedAiProvider().ToString(), false);
        if (AiSettingsStatus is not null) AiSettingsStatus.Text = LocalizationManager.Text("SaveTestRequired");
        RefreshAiSurface();
    }

    private void AiModelChoice_SelectionChanged(object sender, SelectionChangedEventArgs e) => InvalidateSelectedAiConfiguration();
    private void AiModelChoice_LostKeyboardFocus(object sender, System.Windows.Input.KeyboardFocusChangedEventArgs e) => InvalidateSelectedAiConfiguration();
    private void AiEndpoint_TextChanged(object sender, TextChangedEventArgs e)
    { if (SelectedAiProvider() == AiProviderKind.Ollama) InvalidateSelectedAiConfiguration(); }
    private void AiCloudConsent_Unchecked(object sender, RoutedEventArgs e) => InvalidateSelectedAiConfiguration();

    private async void SaveTestAi_Click(object sender, RoutedEventArgs e)
    {
        var provider = SelectedAiProvider();
        var model = SelectedAiModel();
        var entered = AiApiKey.Password.Trim();
        if (provider != AiProviderKind.Ollama && AiCloudConsent.IsChecked != true)
        { AiSettingsStatus.Text = LocalizationManager.Text("CloudConsentRequired"); return; }
        var key = provider == AiProviderKind.Ollama ? null : entered.Length > 0 ? entered : WindowsCredentialVault.Load(provider.ToString());
        AiSettingsStatus.Text = LocalizationManager.Text("TestingConnection");
        try
        {
            await aiClient.ValidateAsync(provider, model, key, AiEndpoint.Text.Trim(), lifetime.Token);
            if (provider != AiProviderKind.Ollama && entered.Length > 0) WindowsCredentialVault.Save(provider.ToString(), entered);
            AgentSettings.AiProvider = provider.ToString(); AgentSettings.SetAiModel(provider.ToString(), model);
            AgentSettings.OllamaEndpoint = AiEndpoint.Text.Trim(); AgentSettings.SetAiCloudConsent(provider.ToString(), AiCloudConsent.IsChecked == true);
            AgentSettings.SetAiEnabled(provider.ToString(), true); AiApiKey.Clear();
            AiSettingsStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("AiReady"), provider, model);
        }
        catch (Exception exception) { AgentSettings.SetAiEnabled(provider.ToString(), false); AiSettingsStatus.Text = DescribeAiFailure(exception, provider); }
        RefreshAiSurface();
    }

    private void RemoveAi_Click(object sender, RoutedEventArgs e)
    {
        var provider = SelectedAiProvider();
        try { if (provider != AiProviderKind.Ollama) WindowsCredentialVault.Delete(provider.ToString()); }
        // Not an AI failure: the credential store refused. The exception's own
        // text names the vault and the entry, which is the kind of detail the
        // status line is supposed to keep out.
        catch (Exception) { AiSettingsStatus.Text = LocalizationManager.Text("AiRemoveFailed"); return; }
        AgentSettings.SetAiEnabled(provider.ToString(), false); AgentSettings.SetAiCloudConsent(provider.ToString(), false); AiCloudConsent.IsChecked = false; AiApiKey.Clear();
        AiSettingsStatus.Text = LocalizationManager.Text("AiRemoved"); RefreshAiSurface();
    }

    private void AiQuestion_TextChanged(object sender, TextChangedEventArgs e) => RefreshAiPreview();

    private AiInsightContext? CurrentAiContext() => currentAnalysis is not null && previousAnalysis is not null
        ? AiInsightContextBuilder.Build(currentAnalysis, previousAnalysis) : null;

    /// The latest exchange on top, so the answer just given is the one on
    /// screen rather than the one at the end of a scroll.
    ///
    /// Exchanges are reversed, not messages. Reversing messages would put
    /// every answer above the question it answers, which reads as nonsense the
    /// longer a conversation gets. An exchange is a question and whatever came
    /// back for it, and inside one the order still runs forwards.
    ///
    /// Only the display is reordered. What is sent to the model comes from
    /// CurrentConversation, which stays in the order things were actually
    /// said; a conversation handed over backwards is a different conversation.
    private static AiMessageRow[] NewestExchangeFirst(IEnumerable<AiConversationMessage> chronological)
    {
        var exchanges = new List<List<AiConversationMessage>>();
        foreach (var message in chronological)
        {
            // Anything before the first question -- a reply whose question was
            // deleted, say -- still needs somewhere to go.
            if (exchanges.Count == 0 || string.Equals(message.Role, "user", StringComparison.OrdinalIgnoreCase))
                exchanges.Add([]);
            exchanges[^1].Add(message);
        }
        exchanges.Reverse();
        return [.. exchanges.SelectMany(exchange => exchange).Select(message => new AiMessageRow(message))];
    }

    private IReadOnlyList<AiConversationMessage> CurrentConversation() =>
        aiHistory.Read().Where(item => item.ConversationId == activeConversationId).OrderBy(item => item.CreatedAt).ToArray();

    private void RefreshAiPreview()
    {
        if (AiPreview is null || AiQuestion is null || CurrentAiContext() is not { } context)
        { if (AiPreview is not null) AiPreview.Text = string.Empty; return; }
        try { AiPreview.Text = string.IsNullOrWhiteSpace(AiQuestion.Text)
            ? AiInsightContextBuilder.Preview(context)
            : aiClient.BuildPreview(SelectedAiProvider(), SelectedAiModel(), context, CurrentConversation(), AiQuestion.Text); }
        // This box shows exactly what would be sent. A .NET message in it reads
        // as part of that payload, which is the one thing it must never do.
        catch (Exception exception) { AiPreview.Text = DescribeAiFailure(exception, SelectedAiProvider()); }
    }

    private void RefreshAiSurface()
    {
        if (AiProviderStatus is null || AiConversation is null) return;
        var provider = SelectedAiProvider();
        AiProviderStatus.Text = AgentSettings.AiEnabled(provider.ToString())
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("AiReady"), provider, AgentSettings.AiModel(provider.ToString()))
            : LocalizationManager.Text("AiOffNotSent");
        var all = aiHistory.Read();
        var choices = all.GroupBy(item => item.ConversationId).Select(group => new AiConversationRow(
            group.Key, group.OrderBy(item => item.CreatedAt).First().Body, group.Max(item => item.CreatedAt)))
            .OrderByDescending(item => item.UpdatedAt).ToList();
        if (choices.All(item => item.Id != activeConversationId)) choices.Insert(0, new AiConversationRow(activeConversationId, LocalizationManager.Text("NewConversation"), DateTimeOffset.Now));
        loadingAiConversation = true;
        AiConversationChoice.ItemsSource = choices;
        AiConversationChoice.SelectedItem = choices.First(item => item.Id == activeConversationId);
        loadingAiConversation = false;
        var messages = NewestExchangeFirst(
            all.Where(item => item.ConversationId == activeConversationId).OrderBy(item => item.CreatedAt));
        AiConversation.ItemsSource = messages;
        AiConversation.Visibility = messages.Length == 0 ? Visibility.Collapsed : Visibility.Visible;
        AiConversationEmptyNote.Visibility = messages.Length == 0 ? Visibility.Visible : Visibility.Collapsed;
        RefreshAiPreview();
    }

    private void AiConversationChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (loadingAiConversation || AiConversationChoice.SelectedItem is not AiConversationRow row) return;
        activeConversationId = row.Id; RefreshAiSurface();
    }

    private async void AskAi_Click(object sender, RoutedEventArgs e)
    {
        if (!AgentSettings.AiEnabled(SelectedAiProvider().ToString()) || CurrentAiContext() is not { } context)
        { AiStatus.Text = LocalizationManager.Text("ConfigureAiFirst"); return; }
        var provider = SelectedAiProvider(); var model = SelectedAiModel(); var question = AiQuestion.Text.Trim();
        try { AiPreview.Text = aiClient.BuildPreview(provider, model, context, CurrentConversation(), question); }
        catch (Exception exception) { AiStatus.Text = DescribeAiFailure(exception, provider); return; }
        if (provider != AiProviderKind.Ollama && System.Windows.MessageBox.Show(
            LocalizationManager.Text("ConfirmCloudSend"), LocalizationManager.Text("ExactPreview"),
            MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;

        aiRequest?.Cancel(); aiRequest?.Dispose(); aiRequest = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        AskAiButton.IsEnabled = false; StopAiButton.IsEnabled = true; AiStatus.Text = LocalizationManager.Text("Analyzing");
        try
        {
            var key = provider == AiProviderKind.Ollama ? null : WindowsCredentialVault.Load(provider.ToString());
            // Said here rather than left to the provider to refuse: a missing
            // key and a rejected one need different actions from the reader.
            if (provider != AiProviderKind.Ollama && string.IsNullOrWhiteSpace(key))
                throw new AiRequestException(AiFailureKind.MissingKey, "No API key is stored for this provider.");
            var prior = CurrentConversation();
            var reply = await aiClient.ChatAsync(provider, model, key, AgentSettings.OllamaEndpoint, context, prior, question, aiRequest.Token);
            var requestId = Guid.NewGuid(); var now = DateTimeOffset.UtcNow;
            aiHistory.Append(new AiConversationMessage(requestId, activeConversationId, "user", question, now, provider.ToString(), model));
            aiHistory.Append(new AiConversationMessage(Guid.NewGuid(), activeConversationId, "assistant", reply.Text, DateTimeOffset.UtcNow,
                provider.ToString(), model, reply.InputTokens, reply.OutputTokens, reply.EstimatedCostUsd));
            AiQuestion.Clear(); AiStatus.Text = LocalizationManager.Text("AnalysisComplete"); RefreshAiSurface();
        }
        catch (OperationCanceledException) { AiStatus.Text = LocalizationManager.Text("AnalysisStopped"); }
        catch (Exception exception) { AiStatus.Text = DescribeAiFailure(exception, provider); }
        finally { AskAiButton.IsEnabled = true; StopAiButton.IsEnabled = false; }
    }

    /// What happened, in the reader's language, without the exception's words.
    ///
    /// A raw message is written once in English by whoever threw it, and can
    /// carry an endpoint, a model name or a path -- none of which belong on a
    /// status line. The same nine kinds are used for every provider, so the
    /// experience does not change depending on which one is configured.
    private static string DescribeAiFailure(Exception exception, AiProviderKind provider)
    {
        var name = provider.ToString();
        var kind = AiRequestException.Classify(exception);
        var status = (exception as AiRequestException)?.StatusCode;
        var key = kind switch
        {
            // A local model that has not answered is usually still reading its
            // weights off disk, and telling someone to check their connection
            // would send them looking in the wrong place.
            AiFailureKind.Timeout => provider == AiProviderKind.Ollama ? "AiTimeoutOllama" : "AiTimeout",
            AiFailureKind.Empty => "AiEmpty",
            AiFailureKind.HttpStatus => "AiHttpStatus",
            AiFailureKind.TooLarge => "AiTooLarge",
            AiFailureKind.InvalidKey => "AiInvalidKey",
            AiFailureKind.MissingKey => "AiMissingKey",
            AiFailureKind.ModelUnavailable => "AiModelUnavailable",
            AiFailureKind.RequestRejected => "AiRequestRejected",
            _ => "AiUnreadable",
        };
        return kind == AiFailureKind.HttpStatus && status is { } code
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text(key), name, code)
            : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text(key), name);
    }

    /// Say what each chart shows, in numbers, for a reader who cannot see it.
    ///
    /// A drawn control has nothing a screen reader can read: it is one opaque
    /// rectangle. A name alone ("Network flow") says what the picture is about
    /// and none of what it says, which is the part worth having. The summary is
    /// rebuilt whenever the data is, because a description that stops matching
    /// the picture is worse than none.
    private void DescribeCharts(PeriodAnalysis data)
    {
        var metric = IsByteMetric
            ? FlowRow.FormatBytes(data.Bytes)
            : string.Format(CultureInfo.CurrentCulture, "{0:N0}", data.Connections);

        static void Describe(FrameworkElement element, string text) =>
            AutomationProperties.SetName(element, text);

        if (data.Links.Count == 0)
        {
            Describe(FlowDiagram, string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("ChartSummaryEmpty"), LocalizationManager.Text("WhichAppWhere")));
        }
        else
        {
            var top = data.Links
                .GroupBy(link => LocalizationManager.Application(link.Application))
                .Select(group => (Name: group.Key, Value: group.Sum(link => IsByteMetric ? link.Bytes : link.Connections)))
                .OrderByDescending(entry => entry.Value).First();
            var total = Math.Max(1, data.Links.Sum(link => IsByteMetric ? link.Bytes : link.Connections));
            Describe(FlowDiagram, string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ChartSummaryFlow"),
                metric, data.Applications, data.Destinations, top.Name, top.Value / (double)total));
        }

        if (data.Timeline.Count == 0)
        {
            Describe(Timeline, string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("ChartSummaryEmpty"), LocalizationManager.Text("WhenTraffic")));
        }
        else
        {
            var buckets = data.Timeline.GroupBy(item => item.Bucket)
                .Select(group => (Bucket: group.Key, Value: group.Sum(item => IsByteMetric ? item.Bytes : item.Connections)))
                .ToArray();
            var busiest = buckets.OrderByDescending(bucket => bucket.Value).First();
            var span = (data.To - data.From).TotalSeconds / Math.Max(1, buckets.Length);
            var at = data.From.AddSeconds(span * busiest.Bucket).LocalDateTime;
            Describe(Timeline, string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ChartSummaryTimeline"),
                metric, buckets.Length, at.ToString("g", CultureInfo.CurrentCulture)));
        }

        if (currentGlobePoints.Count == 0)
        {
            Describe(Globe, string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("ChartSummaryEmpty"), LocalizationManager.Text("CommunicationDestinations")));
        }
        else
        {
            var top = currentGlobePoints.OrderByDescending(point => point.Connections).First();
            Describe(Globe, string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ChartSummaryGlobe"),
                currentGlobePoints.Count, top.City ?? top.CountryCode ?? LocalizationManager.Text("Unknown"),
                top.Connections.ToString("N0", CultureInfo.CurrentCulture)));
        }
    }

    private void StopAi_Click(object sender, RoutedEventArgs e) => aiRequest?.Cancel();
    private void NewConversation_Click(object sender, RoutedEventArgs e) { activeConversationId = Guid.NewGuid(); AiQuestion.Clear(); RefreshAiSurface(); }
    private void DeleteConversation_Click(object sender, RoutedEventArgs e) { aiHistory.Delete(activeConversationId); activeConversationId = Guid.NewGuid(); RefreshAiSurface(); }
    private void DeleteAllConversations_Click(object sender, RoutedEventArgs e) { aiHistory.DeleteAll(); activeConversationId = Guid.NewGuid(); RefreshAiSurface(); }
    private void CopyAi_Click(object sender, RoutedEventArgs e)
    {
        var text = CurrentConversation().LastOrDefault(item => item.Role == "assistant")?.Body ?? AiPreview.Text;
        if (!string.IsNullOrWhiteSpace(text)) System.Windows.Clipboard.SetText(text);
    }

    /// The period picker is hidden on the tab it does not act on.
    ///
    /// Notification history is the newest hundred entries, whatever period is
    /// selected. Leaving a working-looking control above a list it does not
    /// filter is the same fault as a privacy note that no longer matches the
    /// setting under it: the reader has no way to tell it is being ignored.
    /// Hidden rather than disabled, because a greyed-out control still reads
    /// as belonging to this screen and merely unavailable right now.
    private void ShowPeriodWhereItApplies()
    {
        if (PeriodChoice is null || PeriodNotApplicable is null) return;
        // Notification history is the last tab. Its list is the newest
        // hundred entries and no period narrows it.
        var notifications = MainTabs.SelectedIndex == 4;
        PeriodChoice.Visibility = notifications ? Visibility.Collapsed : Visibility.Visible;
        PeriodLabel.Visibility = PeriodChoice.Visibility;
        PeriodNotApplicable.Visibility = notifications ? Visibility.Visible : Visibility.Collapsed;
    }

    private async void MainTabs_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || e.Source != MainTabs) return;
        ShowPeriodWhereItApplies();
        ReconcileLogStream();
        ReconcileCountryAtlasStream();
        await RefreshVisibleAsync();
    }

    /// Enrolling is the moment this PC starts sending anything anywhere, so it
    /// is the moment to ask.
    ///
    /// The list of fields was already on the screen; reading it was optional
    /// and enrolling was one click. The Mac has required this tick since
    /// before the Windows Agent existed, and the cloud AI provider here
    /// already requires one -- so the only path that sent data off this PC
    /// without an explicit yes was the Hub.
    ///
    /// Not remembered: the tick is about this enrolment, and an Agent that
    /// re-enrolled later would ask again.
    private void HubConsent_Click(object sender, RoutedEventArgs e)
    {
        if (EnrollButton is null) return;
        EnrollButton.IsEnabled = HubConsent.IsChecked == true;
        if (EnrollButton.IsEnabled && EnrollmentStatus.Text == LocalizationManager.Text("HubConsentRequired"))
            EnrollmentStatus.Text = LocalizationManager.Text("NotEnrolled");
    }

    private async void Enroll_Click(object sender, RoutedEventArgs e)
    {
        if (HubConsent.IsChecked != true) { EnrollmentStatus.Text = LocalizationManager.Text("HubConsentRequired"); return; }
        if (!Uri.TryCreate(HubUrl.Text.Trim(), UriKind.Absolute, out var hubUrl)) { EnrollmentStatus.Text = EnrollmentMessage("invalid-hub-url"); return; }
        EnrollButton.IsEnabled = HubUrl.IsEnabled = EnrollmentCode.IsEnabled = false;
        try
        {
            EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? "登録を申請しています…" : "Requesting enrollment…";
            var metadata = new AgentEnrollmentMetadata(Environment.MachineName, "windows", Environment.OSVersion.VersionString, "0.1.0-dev");
            var ticket = await enrollment.ApplyAsync(hubUrl, EnrollmentCode.Password, metadata, lifetime.Token);
            EnrollmentCode.Clear();
            while (DateTimeOffset.UtcNow <= ticket.ExpiresAt)
            {
                EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? "Hub管理者の承認を待っています…" : "Waiting for Hub administrator approval…";
                var claim = await enrollment.ClaimOnceAsync(ticket, lifetime.Token);
                if (claim.Status == EnrollmentClaimStatus.Pending) { await Task.Delay(TimeSpan.FromSeconds(3), lifetime.Token); continue; }
                if (claim.Status == EnrollmentClaimStatus.Rejected) throw new AgentEnrollmentException("declined");
                if (claim.Status == EnrollmentClaimStatus.Expired || claim.Credential is null) throw new AgentEnrollmentException("expired");
                var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "save-enrollment", credential = claim.Credential }), lifetime.Token);
                using var document = JsonDocument.Parse(response);
                if (document.RootElement.GetProperty("status").GetString() != "ok") throw new AgentEnrollmentException(document.RootElement.TryGetProperty("reason", out var reason) ? reason.GetString() ?? "credential-storage-failed" : "credential-storage-failed");
                EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? "登録が完了しました。資格情報はServiceが安全に保存しました。" : "Enrollment complete. The Service stored the credential securely.";
                await RefreshDeliveryStatusAsync();
                return;
            }
            throw new AgentEnrollmentException("expired");
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (AgentEnrollmentException exception) { EnrollmentStatus.Text = EnrollmentDiagnostic(exception); }
        catch (Exception exception) { EnrollmentStatus.Text = $"{(LocalizationManager.EffectiveLanguage == "ja" ? "登録に失敗しました。Hubへの接続を確認してください。" : "Enrollment failed. Check the Hub connection.")}\r\nDiagnostic: {exception.GetType().Name}"; }
        finally { EnrollButton.IsEnabled = HubUrl.IsEnabled = EnrollmentCode.IsEnabled = true; }
    }

    private async void DeliveryEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingDeliveryState) return;
        var enabled = DeliveryEnabled.IsChecked == true;
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "set-delivery-enabled", enabled }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            if (document.RootElement.GetProperty("status").GetString() != "ok") throw new InvalidOperationException();
            EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? (enabled ? "観測データのHub送信を開始しました。" : "観測データのHub送信を停止しました。") : (enabled ? "Hub observation delivery is on." : "Hub observation delivery is off.");
            await RefreshDeliveryStatusAsync();
        }
        catch { loadingDeliveryState = true; DeliveryEnabled.IsChecked = !enabled; loadingDeliveryState = false; EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? "送信設定を変更できませんでした。" : "Could not change delivery setting."; }
    }

    private async void SendNow_Click(object sender, RoutedEventArgs e)
    {
        SendNowButton.IsEnabled = false;
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"send-delivery-now"}""", lifetime.Token);
            using var document = JsonDocument.Parse(response);
            if (document.RootElement.GetProperty("status").GetString() != "ok") throw new InvalidOperationException();
            HubDeliveryState.Text = DeliveryStateText("sending");
            await Task.Delay(600, lifetime.Token);
            await RefreshDeliveryStatusAsync();
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch
        {
            HubDeliveryState.Text = LocalizationManager.EffectiveLanguage == "ja" ? "送信を開始できませんでした" : "Could not start delivery";
            await RefreshDeliveryStatusAsync();
        }
    }

    internal static string EnrollmentMessage(string reason)
    {
        var japanese = LocalizationManager.EffectiveLanguage == "ja";
        return reason switch
        {
            "invalid-hub-url" => japanese ? "HTTPSのHub URLを入力してください。HTTPはこのPC内だけ使用できます。" : "Enter an HTTPS Hub URL. HTTP is allowed only on this PC.",
            "invalid-enrollment-code" => japanese ? "6文字の登録コードを確認してください。" : "Check the six-character enrollment code.",
            "plaintext-not-accepted" => japanese ? "Hubが暗号化されていないAgent通信を許可していません。" : "The Hub does not accept unencrypted Agent traffic.",
            "declined" => japanese ? "Hub管理者がこの申請を拒否しました。" : "The Hub administrator declined this request.",
            "expired" => japanese ? "登録申請の有効期限が切れました。新しいコードでやり直してください。" : "The enrollment request expired. Try again with a new code.",
            "credential-storage-failed" => japanese ? "資格情報をServiceへ保存できませんでした。" : "Could not store the credential. Check the Agent Service.",
            _ => japanese ? "登録に失敗しました。コードとHubの状態を確認してください。" : "Enrollment failed. Check the code and Hub status.",
        };
    }
    internal static string EnrollmentDiagnostic(AgentEnrollmentException exception) => EnrollmentMessage(exception.Reason) + $"\r\nDiagnostic: {exception.Reason}{(exception.StatusCode is { } status ? $" (HTTP {status})" : string.Empty)}";

    private void OpenAbout_Click(object sender, RoutedEventArgs e)
    {
        if (System.Windows.Application.Current is App app) app.ShowAbout();
    }
}

/// <param name="readAt">
/// When this page was read from the service. The active mark is judged
/// against it rather than against the wall clock at paint time, so a row that
/// has not changed does not lose its mark merely because a timer ticked.
/// </param>
public sealed class FlowRow(RecentFlow value, bool spansTime = true, DateTimeOffset readAt = default)
{
    /// How recently data must have flowed for a row to be called active.
    ///
    /// The collector watches data, not connections: it handles Datasent and
    /// Datareceived and drops Connect and Disconnect. So nothing here knows
    /// that a connection is open -- only that something crossed it lately.
    ///
    /// Derived from how often the log is read, not written as a number.
    /// Between two reads the screen cannot learn anything new, so a window
    /// shorter than that would drop the mark off flows that are still running.
    /// A literal would go stale the moment the refresh cadence changed, and
    /// then live connections would be shown as finished -- the same shape as
    /// the chart defects.
    internal static TimeSpan ActiveWindow => MainWindow.LogRefreshInterval * 2;

    public DateTimeOffset FirstSeen => value.FirstSeen;
    public string FirstSeenText => value.FirstSeen.LocalDateTime.ToString("G", CultureInfo.CurrentCulture);
    public DateTimeOffset LastSeen => value.LastSeen;
    public string LastSeenText => value.LastSeen.LocalDateTime.ToString("G", CultureInfo.CurrentCulture);

    /// Empty rather than a second word for finished flows: a column where
    /// most rows say nothing reads as a flag, and one where every row says
    /// something reads as noise.
    public string StateText { get; } = spansTime && readAt - value.LastSeen <= ActiveWindow
        ? LocalizationManager.Text("StillActive")
        : string.Empty;

    /// Identifies the same row across refreshes so the list can be updated in
    /// place. Rebuilding it wholesale throws away the selection and the scroll
    /// position every time, which at fifteen seconds is an irritation and at
    /// one second would make the log unreadable.
    public string Key { get; } = spansTime
        ? $"{value.Protocol}|{value.LocalAddress}|{value.LocalPort}|{value.RemoteAddress}|{value.RemotePort}|{value.ProcessId}"
        : $"{value.LastSeen.UtcTicks}|{value.Protocol}|{value.LocalAddress}|{value.LocalPort}|{value.RemoteAddress}|{value.RemotePort}|{value.ProcessId}";
    public string ProcessName => value.ProcessName ?? $"PID {value.ProcessId}";
    public string Destination
    {
        get
        {
            return string.IsNullOrWhiteSpace(value.RemoteHostname) ? value.RemoteAddress : $"{value.RemoteHostname} ({value.RemoteAddress})";
        }
    }
    public int Port => value.RemotePort;
    public string Country => value.CountryCode is { Length: 2 } code
        ? CountryHistoryDisplayRow.LocalizedCountryName(code, LocalizationManager.EffectiveLanguage)
        : LocalizationManager.Text("Unknown");
    public string Protocol => value.Protocol;
    public string BytesReceivedText => FormatBytes(value.BytesReceived);
    public string BytesSentText => FormatBytes(value.BytesSent);
    public long DataVolumeSort => value.BytesSent is { } sent && value.BytesReceived is { } received
        ? sent > long.MaxValue - received ? long.MaxValue : sent + received : -1;
    public string DataVolumeText => (value.BytesSent, value.BytesReceived) switch
    {
        (null, null) => "—",
        ({ } sent, null) => $"≥ {FormatBytes(sent)}",
        (null, { } received) => $"≥ {FormatBytes(received)}",
        _ => FormatBytes(DataVolumeSort),
    };
    public string Origin => value.Origin;
    /// Whether a reader would see any difference between the two rows.
    internal bool LooksSameAs(FlowRow other) =>
        LastSeenText == other.LastSeenText && FirstSeenText == other.FirstSeenText && StateText == other.StateText &&
        BytesSentText == other.BytesSentText && BytesReceivedText == other.BytesReceivedText &&
        Destination == other.Destination && Country == other.Country && ProcessName == other.ProcessName;

    internal static string FormatBytes(long? bytes) => bytes is null ? "—" : bytes < 1024 ? $"{bytes} B" : bytes < 1_048_576 ? $"{bytes / 1024d:N1} KiB" : bytes < 1_073_741_824 ? $"{bytes / 1_048_576d:N1} MiB" : $"{bytes / 1_073_741_824d:N1} GiB";
}

internal sealed class RankedRow(string name, long value, bool bytes)
{
    public string Name { get; } = name;
    public long RawValue { get; } = value;
    public string Value { get; } = bytes ? FlowRow.FormatBytes(value) : value.ToString("N0");
    public string Display => $"{Name}    {Value}";
}

internal sealed class CountryHistoryDisplayRow
{
    public required string Code { get; init; }
    public required string Country { get; init; }
    public required string CountWithUnit { get; init; }
    public required string First { get; init; }
    public required string Last { get; init; }
    public required string RecentApp { get; init; }

    internal static CountryHistoryDisplayRow From(CountryHistoryRow value)
    {
        return new()
        {
            Code = value.CountryCode.ToUpperInvariant(),
            Country = LocalizedCountryName(value.CountryCode, LocalizationManager.EffectiveLanguage),
            CountWithUnit = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("CountryTimes"), value.Connections),
            First = value.FirstObservedAt.LocalDateTime.ToString("g", CultureInfo.CurrentCulture),
            Last = value.LastObservedAt.LocalDateTime.ToString("g", CultureInfo.CurrentCulture),
            RecentApp = value.RecentApplication ?? LocalizationManager.Text("Unknown"),
        };
    }

    internal static string LocalizedCountryName(string countryCode, string language)
    {
        try { return new RegionInfo($"{language}-{countryCode.ToUpperInvariant()}").DisplayName; }
        catch
        {
            try { return new RegionInfo(countryCode).EnglishName; }
            catch { return countryCode; }
        }
    }
}

public sealed class ThreatRow(ThreatFinding value)
{
    public string Confidence => LocalizationManager.Text(value.Confidence == "high" ? "HighAction" : "LowAction");
    public string Destination => value.Destination;
    public string Address => value.Address;
    public string RequestedName => value.RequestedName ?? LocalizationManager.Text("Unavailable");
    public string Application => value.Application;
    public string Connections => value.Connections.ToString("N0");
    public string Feed => value.Source ?? "—";
    public string Reason => value.Tag ?? $"{value.IndicatorKind}: {value.MatchedValue}";
    public string IndicatorKind => value.IndicatorKind.ToUpperInvariant();
    public string MatchedValue => value.MatchedValue;
    public string DataVolume => value.ConnectionsWithoutBytes == 0 ? FlowRow.FormatBytes(value.Bytes) :
        $"{FlowRow.FormatBytes(value.Bytes)} + {value.ConnectionsWithoutBytes:N0} {LocalizationManager.Text("Unmeasured").ToLower(CultureInfo.CurrentCulture)}";
    public string FirstSeen => value.FirstSeen.LocalDateTime.ToString("g");
    public string LastSeen => value.LastSeen.LocalDateTime.ToString("g");
}

internal sealed class NotificationRow(NotificationHistoryEntry value)
{
    public string DateText => value.Date.LocalDateTime.ToString("g");
    public string Kind => value.Kind switch
    {
        "Threat" => LocalizationManager.Text("NotificationKindThreat"),
        "Monitoring" => LocalizationManager.Text("NotificationKindMonitoring"),
        "HubDelivery" => LocalizationManager.Text("NotificationKindHubDelivery"),
        "ThreatIntelChange" => LocalizationManager.Text("NotificationKindThreatIntelChange"),
        "Recovery" => LocalizationManager.Text("NotificationKindRecovery"),
        _ => value.Kind,
    };
    public string Title => value.Title;
    public string Body => value.Body;
    public string Outcome => LocalizationManager.Text(value.Outcome switch
    {
        "shown" => "Delivered",
        "delivery-failed" => "NotDelivered",
        "suppressed-disabled" => "NotificationSuppressedDisabled",
        "suppressed-category" => "NotificationSuppressedCategory",
        "suppressed-cooldown" => "NotificationSuppressedCooldown",
        "suppressed-daily-limit" => "NotificationSuppressedDailyLimit",
        _ => "Suppressed",
    });
}

internal sealed class AiMessageRow(AiConversationMessage value)
{
    public string Header => $"{value.Role} · {value.Provider} / {value.Model} · {value.CreatedAt.LocalDateTime:g}";
    public string Body => value.Body;
    public string Usage => value.InputTokens is null && value.OutputTokens is null ? string.Empty :
        $"{value.InputTokens:N0} in / {value.OutputTokens:N0} out" + (value.EstimatedCostUsd is { } cost ? $" · est. ${cost:F6}" : string.Empty);
}

internal sealed class AiConversationRow(Guid id, string firstQuestion, DateTimeOffset updatedAt)
{
    public Guid Id { get; } = id;
    public string FirstQuestion { get; } = firstQuestion;
    public DateTimeOffset UpdatedAt { get; } = updatedAt;
    public override string ToString() => $"{FirstQuestion[..Math.Min(FirstQuestion.Length, 28)]} · {UpdatedAt.LocalDateTime:g}";
}
