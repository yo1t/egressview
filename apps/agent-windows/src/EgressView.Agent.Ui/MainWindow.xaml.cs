using System.Collections.ObjectModel;
using System.ComponentModel;
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
    private IReadOnlyList<GlobePoint> currentGlobePoints = [];
    public ObservableCollection<FlowRow> RecentFlows { get; } = [];
    public ObservableCollection<ThreatRow> ThreatRows { get; } = [];

    public MainWindow()
    {
        InitializeComponent();
        Width = Math.Min(AgentSettings.WindowWidth, SystemParameters.WorkArea.Width);
        Height = Math.Min(AgentSettings.WindowHeight, SystemParameters.WorkArea.Height);
        ApplyAccessibilityLabels();
        DataContext = this;
        Loaded += async (_, _) => { LoadSettings(); await RefreshAllAsync(); refreshTimer.Start(); };
        IsVisibleChanged += (_, _) => { if (IsVisible) refreshTimer.Start(); else refreshTimer.Stop(); };
        refreshTimer.Tick += async (_, _) => { if (IsVisible && IsActive) await RefreshVisibleAsync(); };
        Closing += SaveWindowSize;
        Closing += HideToTray;
        Closed += (_, _) => { refreshTimer.Stop(); lifetime.Cancel(); };
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
        await RefreshVisibleAsync();
    }

    private async void AnalysisChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
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
            CountryList.ItemsSource = currentGlobePoints.GroupBy(point => point.CountryCode ?? LocalizationManager.Text("Unknown"))
                .Select(group => new RankedRow(group.Key, group.Sum(point => IsByteMetric ? point.Bytes : point.Connections), IsByteMetric)).OrderByDescending(row => row.RawValue).ToArray();
            GlobeCaption.Text = currentGlobePoints.Count == 0
                ? LocalizationManager.Text("GlobeUnavailable")
                : string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("GlobeLocations"), currentGlobePoints.Count);
            AutomationProperties.SetHelpText(Globe, GlobeCaption.Text);
            await RefreshThreatsAsync();
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
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
            InsightConnections.Text = current.Connections.ToString("N0");
            InsightApplications.Text = current.Applications.ToString("N0");
            InsightDestinations.Text = current.Destinations.ToString("N0");
            InsightBytes.Text = FlowRow.FormatBytes(current.Bytes);
            InsightConnectionsDelta.Text = previous is null || previous.Connections == 0 ? LocalizationManager.Text("NoPreviousData") : $"{(current.Connections - previous.Connections) / (double)previous.Connections:+0%;-0%;0%} {LocalizationManager.Text("VersusPrevious")}";
            TopApplicationsList.ItemsSource = current.Links.GroupBy(link => link.Application).Select(group => new RankedRow(group.Key, group.Sum(link => IsByteMetric ? link.Bytes : link.Connections), IsByteMetric)).OrderByDescending(row => row.RawValue).Take(10).ToArray();
            var names = DestinationChoice.SelectedIndex == 0;
            TopDestinationsList.ItemsSource = current.Links.GroupBy(link => names ? link.DestinationName : link.Destination).Select(group => new RankedRow(group.Key, group.Sum(link => IsByteMetric ? link.Bytes : link.Connections), IsByteMetric)).OrderByDescending(row => row.RawValue).Take(10).ToArray();
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
            var status = report.Availability switch { "available" when report.Findings.Count == 0 => LocalizationManager.Text("NoThreatMatches"), "available" => string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ThreatMatches"), report.Findings.Count), "unavailable" => LocalizationManager.Text("HubNoThreatFeeds"), _ => LocalizationManager.Text("ThreatNotChecked") };
            ThreatStatus.Text = report.Availability == "available"
                ? $"{status} {string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("DomainCoverage"), report.DomainCheckedDestinations, report.DomainUncheckedDestinations)}"
                : status;
        }
        catch { ThreatStatus.Text = LocalizationManager.Text("ThreatNotChecked"); ThreatCount.Text = "—"; }
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
        CountryList.Visibility = countries ? Visibility.Visible : Visibility.Collapsed;
        RotateButton.Visibility = countries ? Visibility.Collapsed : Visibility.Visible;
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
        DailyLimitChoice.SelectedIndex = AgentSettings.NotificationDailyLimit switch { 5 => 0, 20 => 2, _ => 1 };
        FrameRateChoice.SelectedIndex = AgentSettings.GlobeFrameRate switch { 3 => 0, 15 => 2, _ => 1 };
        SettingsSectionChoice.SelectedIndex = AgentSettings.SettingsSection switch { "notifications" => 1, "enrichment" => 2, "hub" => 3, _ => 0 };
        Globe.FramesPerSecond = AgentSettings.GlobeFrameRate;
        loadingSettings = false;
    }

    private void SettingsSectionChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (GeneralSettingsSection is null || NotificationSettingsSection is null || EnrichmentSettingsSection is null || HubSettingsSection is null ||
            SettingsSectionChoice.SelectedItem is not ListBoxItem item) return;
        var section = item.Tag?.ToString() ?? "general";
        GeneralSettingsSection.Visibility = section == "general" ? Visibility.Visible : Visibility.Collapsed;
        NotificationSettingsSection.Visibility = section == "notifications" ? Visibility.Visible : Visibility.Collapsed;
        EnrichmentSettingsSection.Visibility = section == "enrichment" ? Visibility.Visible : Visibility.Collapsed;
        HubSettingsSection.Visibility = section == "hub" ? Visibility.Visible : Visibility.Collapsed;
        if (!loadingSettings) AgentSettings.SettingsSection = section;
        if (section == "enrichment") _ = RefreshEnrichmentStatusAsync();
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
        if (DailyLimitChoice.SelectedItem is ComboBoxItem item && int.TryParse(item.Content?.ToString(), out var value)) AgentSettings.NotificationDailyLimit = value;
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
        NotificationSummary.Text = $"{LocalizationManager.Text("NotificationsToday")}: {app.Notifications.SentToday:N0} · {LocalizationManager.Text("SuppressedToday")}: {app.Notifications.SuppressedToday:N0}";
        NotificationList.ItemsSource = app.Notifications.History.Select(item => new NotificationRow(item)).ToArray();
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

public sealed class ThreatRow(ThreatFinding value)
{
    public string Confidence => LocalizationManager.Text(value.Confidence == "high" ? "HighConfidence" : "LowConfidence");
    public string Destination => value.Destination;
    public string Application => value.Application;
    public string Connections => value.Connections.ToString("N0");
    public string Feed => value.Source ?? "—";
    public string Reason => value.Tag ?? $"{value.IndicatorKind}: {value.MatchedValue}";
}

internal sealed class NotificationRow(NotificationHistoryEntry value)
{
    public string DateText => value.Date.LocalDateTime.ToString("g");
    public string Kind => value.Kind;
    public string Title => value.Title;
    public string Body => value.Body;
}
