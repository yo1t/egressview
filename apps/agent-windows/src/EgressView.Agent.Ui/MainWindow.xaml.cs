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
    private readonly AgentEnrollmentClient enrollment = new();
    private readonly CancellationTokenSource lifetime = new();
    private readonly DispatcherTimer refreshTimer = new() { Interval = TimeSpan.FromSeconds(15) };
    private bool loadingSettings;
    private bool loadingDeliveryState;
    private int selectedMinutes = 10_080;
    private IReadOnlyList<RecentFlow> rawFlows = [];
    private PeriodAnalysis? currentAnalysis;
    private PeriodAnalysis? previousAnalysis;
    private IReadOnlyList<GlobePoint> currentGlobePoints = [];
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
        if (aiHistory.Read().OrderByDescending(item => item.CreatedAt).FirstOrDefault() is { } latest)
            activeConversationId = latest.ConversationId;
        Width = Math.Min(AgentSettings.WindowWidth, SystemParameters.WorkArea.Width);
        Height = Math.Min(AgentSettings.WindowHeight, SystemParameters.WorkArea.Height);
        ApplyAccessibilityLabels();
        DataContext = this;
        Loaded += async (_, _) => { LoadSettings(); await RefreshAllAsync(); refreshTimer.Start(); };
        IsVisibleChanged += (_, _) => { if (IsVisible) refreshTimer.Start(); else refreshTimer.Stop(); };
        refreshTimer.Tick += async (_, _) => { if (IsVisible && IsActive) await RefreshVisibleAsync(); };
        Closing += SaveWindowSize;
        Closing += HideToTray;
        Closed += (_, _) => { refreshTimer.Stop(); lifetime.Cancel(); aiRequest?.Cancel(); aiClient.Dispose(); };
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
    }

    internal Task RefreshStatusFromTrayAsync() => RefreshStatusAsync();

    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshAllAsync();
    private async void PeriodChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded || PeriodChoice.SelectedItem is not ComboBoxItem item || !int.TryParse(item.Tag?.ToString(), out selectedMinutes)) return;
        if (!loadingSettings) AgentSettings.PeriodMinutes = selectedMinutes;
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
        3 => RefreshThreatsAsync(),
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
            await RefreshCountryHistoryAsync();
            GlobeCaption.Text = currentGlobePoints.Count == 0
                ? LocalizationManager.Text("GlobeUnavailable")
                : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("GlobeLocations"), currentGlobePoints.Count);
            AutomationProperties.SetHelpText(Globe, GlobeCaption.Text);
            await RefreshThreatsAsync();
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
    }

    private async Task RefreshCountryHistoryAsync()
    {
        var all = CountryScopeChoice.SelectedIndex == 1;
        var request = all
            ? JsonSerializer.Serialize(new { v = 1, op = "country-history", scope = "all" })
            : JsonSerializer.Serialize(new { v = 1, op = "country-history", scope = "period", minutes = selectedMinutes });
        var response = await AgentIpcClient.RequestAsync(request, lifetime.Token);
        using var document = JsonDocument.Parse(response);
        var rows = document.RootElement.GetProperty("data").Deserialize<List<CountryHistoryRow>>() ?? [];
        CountryList.ItemsSource = rows.Select(CountryHistoryDisplayRow.From).ToArray();
    }

    private async Task RefreshFlowsAsync()
    {
        try
        {
            var limit = SelectedLimit();
            rawFlows = await ReadFlowPageAsync(limit, 0);
            PopulateCountryFilter();
            ApplyLogFilter();
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
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
        CoverageValue.Text = data.CoverageRatio >= 0.999999999
            ? "100%"
            : $"{Math.Min(data.CoverageRatio, 0.999):P1}";
        StorageSummary.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("StorageSummary"), data.StoredFlows.ToString("N0"), FlowRow.FormatBytes(data.StorageBytes));
        MonitoringSince.Text = data.MonitoringStartedAt is { } started ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("MonitoringSince"), started.LocalDateTime.ToString("g")) : string.Empty;
        CoverageNote.Text = data.CoverageRatio < 0.999999999
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("PartialCoverage"), Math.Min(data.CoverageRatio, 0.999))
            : string.Empty;
        var names = DestinationChoice.SelectedIndex == 0;
        FlowDiagram.SetItems(data.Links, IsByteMetric, names);
        Timeline.SetItems(data.Timeline, IsByteMetric, data.From, data.To);
        FlowCaption.Text = IsByteMetric ? LocalizationManager.Text("RibbonBytes") : LocalizationManager.Text("RibbonConnections");
        TimelineCaption.Text = IsByteMetric ? LocalizationManager.Text("TimelineBytes") : LocalizationManager.Text("TimelineTotal");
        AutomationProperties.SetHelpText(FlowDiagram, FlowCaption.Text);
        AutomationProperties.SetHelpText(Timeline, TimelineCaption.Text);
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
            InsightConnectionsDelta.Text = previous is null || previous.Connections == 0 ? LocalizationManager.Text("NoPreviousData") : $"{(current.Connections - previous.Connections) / (double)previous.Connections:+0%;-0%;0%} {LocalizationManager.Text("VersusPrevious")}";
            TopApplicationsList.ItemsSource = current.Links.GroupBy(link => link.Application).Select(group => new RankedRow(group.Key, group.Sum(link => IsByteMetric ? link.Bytes : link.Connections), IsByteMetric)).OrderByDescending(row => row.RawValue).Take(10).ToArray();
            var names = DestinationChoice.SelectedIndex == 0;
            TopDestinationsList.ItemsSource = current.Links.GroupBy(link => names ? link.DestinationName : link.Destination).Select(group => new RankedRow(group.Key, group.Sum(link => IsByteMetric ? link.Bytes : link.Connections), IsByteMetric)).OrderByDescending(row => row.RawValue).Take(10).ToArray();
            RefreshAiSurface();
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
    }

    private async Task RefreshThreatsAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "threats", minutes = selectedMinutes }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            var report = document.RootElement.GetProperty("data").Deserialize<ThreatReport>() ?? throw new InvalidDataException();
            ThreatRows.Clear(); foreach (var finding in report.Findings) ThreatRows.Add(new(finding));
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
        }
        catch { ThreatStatus.Text = LocalizationManager.Text("ThreatNotChecked"); ThreatCount.Text = "—"; }
    }

    private void ThreatGrid_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (ThreatGrid.SelectedItem is not ThreatRow row) { ThreatDetail.Text = LocalizationManager.Text("SelectThreat"); return; }
        ThreatDetail.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ThreatDetailFormat"),
            row.Address, row.RequestedName, row.Application, row.IndicatorKind, row.MatchedValue, row.Feed, row.Reason,
            row.Connections, row.DataVolume, row.FirstSeen, row.LastSeen);
    }

    private void LogFilter_Changed(object sender, RoutedEventArgs e) { if (IsLoaded) ApplyLogFilter(); }
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
        RecentFlows.Clear(); foreach (var flow in filtered) RecentFlows.Add(new FlowRow(flow));
        var active = new[] { app.Length > 0, destination.Length > 0, port.Length > 0, country != "all", protocol != "all", volume != "all", collector != "all" }.Count(value => value);
        LogStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("LogCountStatus"), filtered.Length, rawFlows.Count, active);
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
        RotateButton.Visibility = countries ? Visibility.Collapsed : Visibility.Visible;
        SpinSpeedChoice.Visibility = countries ? Visibility.Collapsed : Visibility.Visible;
        if (!loadingSettings) AgentSettings.GlobeView = countries ? "countries" : "globe";
    }

    private async void CountryScopeChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (IsLoaded) await RefreshCountryHistoryAsync();
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
            SetMonitoringState(healthy, monitoringEnabled);
            if (System.Windows.Application.Current is App trayApp) trayApp.UpdateTrayState(monitoringEnabled, healthy);
            var coverage = data.GetProperty("coverage");
            CoverageValue.Text = !monitoringEnabled ? LocalizationManager.Text("MonitoringStopped") :
                coverage.GetProperty("active").GetInt64() > 0 ? LocalizationManager.Text("Monitoring") : LocalizationManager.Text("NeedsAttention");
            loadingDeliveryState = true;
            DeliveryEnabled.IsChecked = data.GetProperty("deliveryEnabled").GetBoolean();
            loadingDeliveryState = false;
            if (!healthy && System.Windows.Application.Current is App app)
                app.Notifications.Notify("Monitoring", "monitoring-health", "EgressView Agent", LocalizationManager.Text("NeedsAttention"), app.ShowNotification);
            await RefreshDeliveryStatusAsync();
        }
        catch { SetMonitoringState(false); CoverageValue.Text = LocalizationManager.Text("NeedsAttention"); if (System.Windows.Application.Current is App app) app.UpdateTrayState(true, false); }
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
            HubPending.Text = data.GetProperty("pending").GetInt64().ToString("N0", CultureInfo.CurrentCulture);
            HubLastAck.Text = DateText(data, "lastAcknowledgedAt");
            HubOldestPending.Text = $"{LocalizationManager.Text("OldestPending")}: {DateText(data, "oldestPendingAt")}";
            HubRetry.Text = $"{LocalizationManager.Text("NextRetry")}: {DateText(data, "nextRetryAt")}";
            var failure = data.TryGetProperty("lastFailure", out var failureValue) && failureValue.ValueKind == JsonValueKind.String
                ? DeliveryStateText(failureValue.GetString() ?? "") : "—";
            var statusCode = data.TryGetProperty("lastStatusCode", out var statusValue) && statusValue.ValueKind == JsonValueKind.Number
                ? $" (HTTP {statusValue.GetInt32()})" : string.Empty;
            HubLastFailure.Text = $"{LocalizationManager.Text("LastFailure")}: {failure}{statusCode}";
            SendNowButton.IsEnabled = enrolled && enabled && state != "sending";
        }
        catch
        {
            HubDeliveryState.Text = LocalizationManager.Text("CannotConnect");
            SendNowButton.IsEnabled = false;
        }
    }

    private static string DateText(JsonElement data, string property)
    {
        if (!data.TryGetProperty(property, out var value) || value.ValueKind != JsonValueKind.String ||
            !DateTimeOffset.TryParse(value.GetString(), out var date)) return "—";
        return date.ToLocalTime().ToString("g", CultureInfo.CurrentCulture);
    }

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
            _ => ja ? "待機中" : "Idle",
        };
    }

    private void SetMonitoringState(bool healthy, bool enabled = true)
    {
        MonitoringStatus.Text = enabled ? LocalizationManager.Text(healthy ? "Monitoring" : "NeedsAttention") : LocalizationManager.Text("MonitoringStopped");
        MonitoringStatus.Foreground = (System.Windows.Media.Brush)FindResource(enabled && healthy ? "SuccessBrush" : "ErrorBrush");
        MonitoringDot.Fill = MonitoringStatus.Foreground;
        MonitoringBadge.Background = (System.Windows.Media.Brush)FindResource(healthy ? "SuccessSoftBrush" : "ErrorSoftBrush");
    }

    private void Rotate_Click(object sender, RoutedEventArgs e)
    {
        Globe.IsRotating = !Globe.IsRotating;
        RotateButton.SetResourceReference(ContentProperty, Globe.IsRotating ? "Stop" : "Rotate");
    }

    private async void RowLimit_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded) await RefreshFlowsAsync(); }
    private int SelectedLimit() => RowLimit.SelectedItem is ComboBoxItem item && int.TryParse(item.Content?.ToString(), out var value) ? value : 100;

    private static async Task<IReadOnlyList<RecentFlow>> ReadFlowPageAsync(int limit, int offset, CancellationToken cancellationToken = default)
    {
        var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "recent-flows", limit, offset }), cancellationToken);
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
                var page = await ReadFlowPageAsync(500, offset, lifetime.Token);
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
        LanguageChoice.SelectedIndex = (int)AgentSettings.Language;
        NotificationsEnabled.IsChecked = AgentSettings.NotificationsEnabled;
        NotifyThreat.IsChecked = AgentSettings.NotificationCategoryEnabled("Threat");
        NotifyMonitoring.IsChecked = AgentSettings.NotificationCategoryEnabled("Monitoring");
        NotifyHubDelivery.IsChecked = AgentSettings.NotificationCategoryEnabled("HubDelivery");
        NotifyThreatIntel.IsChecked = AgentSettings.NotificationCategoryEnabled("ThreatIntel");
        NotifyRecovery.IsChecked = AgentSettings.NotificationCategoryEnabled("Recovery");
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
        SettingsSectionChoice.SelectedIndex = AgentSettings.SettingsSection switch { "notifications" => 1, "enrichment" => 2, "ai" => 3, "history" => 4, "diagnostics" => 5, "updates" => 6, "hub" => 7, "uninstall" => 8, "about" => 9, _ => 0 };
        DeleteHistoryBefore.SelectedDate = DateTime.Today.AddDays(-30);
        AiProviderChoice.SelectedIndex = AgentSettings.AiProvider switch { "OpenAI" => 1, "Anthropic" => 2, _ => 0 };
        AiEndpoint.Text = AgentSettings.OllamaEndpoint;
        AiCloudConsent.IsChecked = AgentSettings.AiCloudConsent(AgentSettings.AiProvider);
        PopulateAiModels();
        Globe.FramesPerSecond = AgentSettings.GlobeFrameRate;
        Globe.DegreesPerSecond = AgentSettings.GlobeSpinSpeed switch { "slow" => 2, "fast" => 14, _ => 6 };
        loadingSettings = false;
    }

    private void SettingsSectionChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (GeneralSettingsSection is null || NotificationSettingsSection is null || EnrichmentSettingsSection is null || AiSettingsSection is null || HistorySettingsSection is null || DiagnosticsSettingsSection is null || UpdateSettingsSection is null || HubSettingsSection is null || UninstallSettingsSection is null || AboutSettingsSection is null ||
            SettingsSectionChoice.SelectedItem is not ListBoxItem item) return;
        var section = item.Tag?.ToString() ?? "general";
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
            var value = AgentSettingsFile.Decode(bytes);
            var fields = AgentSettingsFile.PresentFields(value);
            var preview = string.Join("\r\n", fields.Select(field => $"• {field}: {PortableValue(value, field)}"));
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
            PortableSettingsStatus.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("SettingsImportedFormat"), fields.Count);
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
        _ = RefreshStatusAsync();
        RefreshNotifications();
    }

    private void ApplyAccessibilityLabels()
    {
        static void Name(FrameworkElement element, string key) => AutomationProperties.SetName(element, LocalizationManager.Text(key));
        Name(PeriodChoice, "Period");
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
        Name(RefreshThreatButton, "FetchNow");
        AutomationProperties.SetName(HubUrl, "Hub URL");
        foreach (var status in new[] { MonitoringStatus, CoverageNote, LogStatus, ThreatStatus, NotificationSummary, EnrollmentStatus })
            AutomationProperties.SetLiveSetting(status, AutomationLiveSetting.Polite);
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
            RefreshGeoButton.IsEnabled = RefreshThreatButton.IsEnabled = enrolled;
        }
        catch
        {
            EnrichmentSource.Text = LocalizationManager.Text("CannotConnect");
            RefreshGeoButton.IsEnabled = RefreshThreatButton.IsEnabled = false;
        }
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
        foreach (var box in new[] { NotifyThreat, NotifyMonitoring, NotifyHubDelivery, NotifyThreatIntel, NotifyRecovery })
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
        var saved = AgentSettings.AiModel(SelectedAiProvider().ToString());
        var models = SelectedAiProvider() switch
        {
            AiProviderKind.OpenAI => AgentAiClient.OpenAiModels,
            AiProviderKind.Anthropic => AgentAiClient.AnthropicModels,
            _ => Array.Empty<string>(),
        };
        AiModelChoice.ItemsSource = models;
        AiModelChoice.IsEditable = SelectedAiProvider() == AiProviderKind.Ollama;
        AiModelChoice.Text = saved.Length > 0 ? saved : models.FirstOrDefault() ?? string.Empty;
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
        catch (Exception exception) { AgentSettings.SetAiEnabled(provider.ToString(), false); AiSettingsStatus.Text = exception.Message; }
        RefreshAiSurface();
    }

    private void RemoveAi_Click(object sender, RoutedEventArgs e)
    {
        var provider = SelectedAiProvider();
        try { if (provider != AiProviderKind.Ollama) WindowsCredentialVault.Delete(provider.ToString()); }
        catch (Exception exception) { AiSettingsStatus.Text = exception.Message; return; }
        AgentSettings.SetAiEnabled(provider.ToString(), false); AgentSettings.SetAiCloudConsent(provider.ToString(), false); AiCloudConsent.IsChecked = false; AiApiKey.Clear();
        AiSettingsStatus.Text = LocalizationManager.Text("AiRemoved"); RefreshAiSurface();
    }

    private void AiQuestion_TextChanged(object sender, TextChangedEventArgs e) => RefreshAiPreview();

    private AiInsightContext? CurrentAiContext() => currentAnalysis is not null && previousAnalysis is not null
        ? AiInsightContextBuilder.Build(currentAnalysis, previousAnalysis) : null;

    private IReadOnlyList<AiConversationMessage> CurrentConversation() =>
        aiHistory.Read().Where(item => item.ConversationId == activeConversationId).OrderBy(item => item.CreatedAt).ToArray();

    private void RefreshAiPreview()
    {
        if (AiPreview is null || AiQuestion is null || string.IsNullOrWhiteSpace(AiQuestion.Text) || CurrentAiContext() is not { } context)
        { if (AiPreview is not null) AiPreview.Text = string.Empty; return; }
        try { AiPreview.Text = aiClient.BuildPreview(SelectedAiProvider(), SelectedAiModel(), context, CurrentConversation(), AiQuestion.Text); }
        catch (Exception exception) { AiPreview.Text = exception.Message; }
    }

    private void RefreshAiSurface()
    {
        if (AiProviderStatus is null || AiConversation is null) return;
        var provider = SelectedAiProvider();
        AiProviderStatus.Text = AgentSettings.AiEnabled(provider.ToString())
            ? string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("AiReady"), provider, AgentSettings.AiModel(provider.ToString()))
            : LocalizationManager.Text("AiDisabled");
        var all = aiHistory.Read();
        var choices = all.GroupBy(item => item.ConversationId).Select(group => new AiConversationRow(
            group.Key, group.OrderBy(item => item.CreatedAt).First().Body, group.Max(item => item.CreatedAt)))
            .OrderByDescending(item => item.UpdatedAt).ToList();
        if (choices.All(item => item.Id != activeConversationId)) choices.Insert(0, new AiConversationRow(activeConversationId, LocalizationManager.Text("NewConversation"), DateTimeOffset.Now));
        loadingAiConversation = true;
        AiConversationChoice.ItemsSource = choices;
        AiConversationChoice.SelectedItem = choices.First(item => item.Id == activeConversationId);
        loadingAiConversation = false;
        AiConversation.ItemsSource = all.Where(item => item.ConversationId == activeConversationId).OrderBy(item => item.CreatedAt).Select(item => new AiMessageRow(item)).ToArray();
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
        catch (Exception exception) { AiStatus.Text = exception.Message; return; }
        if (provider != AiProviderKind.Ollama && System.Windows.MessageBox.Show(
            LocalizationManager.Text("ConfirmCloudSend"), LocalizationManager.Text("ExactPreview"),
            MessageBoxButton.YesNo, MessageBoxImage.Warning) != MessageBoxResult.Yes) return;

        aiRequest?.Cancel(); aiRequest?.Dispose(); aiRequest = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        AskAiButton.IsEnabled = false; StopAiButton.IsEnabled = true; AiStatus.Text = LocalizationManager.Text("Analyzing");
        try
        {
            var key = provider == AiProviderKind.Ollama ? null : WindowsCredentialVault.Load(provider.ToString());
            var prior = CurrentConversation();
            var reply = await aiClient.ChatAsync(provider, model, key, AgentSettings.OllamaEndpoint, context, prior, question, aiRequest.Token);
            var requestId = Guid.NewGuid(); var now = DateTimeOffset.UtcNow;
            aiHistory.Append(new AiConversationMessage(requestId, activeConversationId, "user", question, now, provider.ToString(), model));
            aiHistory.Append(new AiConversationMessage(Guid.NewGuid(), activeConversationId, "assistant", reply.Text, DateTimeOffset.UtcNow,
                provider.ToString(), model, reply.InputTokens, reply.OutputTokens, reply.EstimatedCostUsd));
            AiQuestion.Clear(); AiStatus.Text = LocalizationManager.Text("AnalysisComplete"); RefreshAiSurface();
        }
        catch (OperationCanceledException) { AiStatus.Text = LocalizationManager.Text("AnalysisStopped"); }
        catch (Exception exception) { AiStatus.Text = exception.Message; }
        finally { AskAiButton.IsEnabled = true; StopAiButton.IsEnabled = false; }
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

    private async void MainTabs_SelectionChanged(object sender, SelectionChangedEventArgs e) { if (IsLoaded && e.Source == MainTabs) await RefreshVisibleAsync(); }

    private async void Enroll_Click(object sender, RoutedEventArgs e)
    {
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

public sealed class FlowRow(RecentFlow value)
{
    public DateTimeOffset LastSeen => value.LastSeen;
    public string LastSeenText => value.LastSeen.LocalDateTime.ToString("g");
    public string ProcessName => value.ProcessName ?? $"PID {value.ProcessId}";
    public string Destination
    {
        get
        {
            return string.IsNullOrWhiteSpace(value.RemoteHostname) ? value.RemoteAddress : $"{value.RemoteHostname} ({value.RemoteAddress})";
        }
    }
    public int Port => value.RemotePort;
    public string Country => value.CountryCode ?? LocalizationManager.Text("Unknown");
    public string Protocol => value.Protocol;
    public string BytesReceivedText => FormatBytes(value.BytesReceived);
    public string BytesSentText => FormatBytes(value.BytesSent);
    public string Origin => value.Origin;
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
    public required string Country { get; init; }
    public required string Connections { get; init; }
    public required string First { get; init; }
    public required string Last { get; init; }

    internal static CountryHistoryDisplayRow From(CountryHistoryRow value)
    {
        string country;
        try { country = $"{new RegionInfo(value.CountryCode).DisplayName} ({value.CountryCode})"; }
        catch { country = value.CountryCode; }
        return new()
        {
            Country = country,
            Connections = value.Connections.ToString("N0", CultureInfo.CurrentCulture),
            First = value.FirstObservedAt.LocalDateTime.ToString("g", CultureInfo.CurrentCulture),
            Last = value.LastObservedAt.LocalDateTime.ToString("g", CultureInfo.CurrentCulture),
        };
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
    public string Kind => value.Kind;
    public string Title => value.Title;
    public string Body => value.Body;
    public string Outcome => LocalizationManager.Text(value.Outcome switch { "shown" => "Delivered", "delivery-failed" => "NotDelivered", _ => "Suppressed" });
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
