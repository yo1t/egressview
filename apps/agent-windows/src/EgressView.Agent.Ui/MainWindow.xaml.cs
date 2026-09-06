using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Windows;
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
        DataContext = this;
        Loaded += async (_, _) => { LoadSettings(); await RefreshAllAsync(); refreshTimer.Start(); };
        IsVisibleChanged += (_, _) => { if (IsVisible) refreshTimer.Start(); else refreshTimer.Stop(); };
        refreshTimer.Tick += async (_, _) => { if (IsVisible && IsActive) await RefreshVisibleAsync(); };
        Closing += HideToTray;
        Closed += (_, _) => { refreshTimer.Stop(); lifetime.Cancel(); };
    }

    private void HideToTray(object? sender, CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App { IsExiting: false }) { e.Cancel = true; Hide(); }
    }

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

    private bool IsByteMetric => MetricChoice.SelectedItem is ComboBoxItem item && Equals(item.Tag, "bytes");

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
        var names = DestinationChoice.SelectedItem is ComboBoxItem destination && Equals(destination.Tag, "name");
        FlowDiagram.SetItems(data.Links, IsByteMetric, names);
        Timeline.SetItems(data.Timeline, IsByteMetric, data.From, data.To);
        FlowCaption.Text = IsByteMetric ? LocalizationManager.Text("RibbonBytes") : LocalizationManager.Text("RibbonConnections");
        TimelineCaption.Text = IsByteMetric ? LocalizationManager.Text("TimelineBytes") : LocalizationManager.Text("TimelineTotal");
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
            var names = DestinationChoice.SelectedItem is ComboBoxItem destination && Equals(destination.Tag, "name");
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
        var query = LogSearch.Text.Trim();
        var protocol = ProtocolFilter.SelectedItem is ComboBoxItem item ? item.Tag?.ToString() : "all";
        var filtered = rawFlows.Where(flow => (protocol == "all" || flow.Protocol == protocol) &&
            (query.Length == 0 || (flow.ProcessName?.Contains(query, StringComparison.CurrentCultureIgnoreCase) ?? false) || flow.RemoteAddress.Contains(query, StringComparison.OrdinalIgnoreCase))).ToArray();
        RecentFlows.Clear(); foreach (var flow in filtered) RecentFlows.Add(new FlowRow(flow));
        LogStatus.Text = filtered.Length == 0 ? LocalizationManager.Text("NoConnections") : $"{filtered.Length:N0} {LocalizationManager.Text("Rows").ToLower(CultureInfo.CurrentCulture)}";
    }

    private void GlobeViewChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (!IsLoaded) return;
        var countries = GlobeViewChoice.SelectedItem is ComboBoxItem item && Equals(item.Tag, "countries");
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
            SetMonitoringState(healthy);
            var coverage = data.GetProperty("coverage");
            CoverageValue.Text = coverage.GetProperty("active").GetInt64() > 0 ? LocalizationManager.Text("Monitoring") : LocalizationManager.Text("NeedsAttention");
            loadingDeliveryState = true;
            DeliveryEnabled.IsChecked = data.GetProperty("deliveryEnabled").GetBoolean();
            loadingDeliveryState = false;
            if (!healthy && System.Windows.Application.Current is App app)
                app.Notifications.Notify("Monitoring", "monitoring-health", "EgressView Agent", LocalizationManager.Text("NeedsAttention"), app.ShowNotification);
        }
        catch { SetMonitoringState(false); CoverageValue.Text = LocalizationManager.Text("NeedsAttention"); }
    }

    private void SetMonitoringState(bool healthy)
    {
        MonitoringStatus.Text = LocalizationManager.Text(healthy ? "Monitoring" : "NeedsAttention");
        MonitoringStatus.Foreground = (System.Windows.Media.Brush)FindResource(healthy ? "SuccessBrush" : "ErrorBrush");
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
        Globe.FramesPerSecond = AgentSettings.GlobeFrameRate;
        loadingSettings = false;
    }

    private void LanguageChoice_SelectionChanged(object sender, SelectionChangedEventArgs e)
    {
        if (loadingSettings || LanguageChoice.SelectedItem is not ComboBoxItem item || !Enum.TryParse<AgentLanguage>(item.Tag?.ToString(), out var language)) return;
        AgentSettings.Language = language;
        LocalizationManager.Apply(System.Windows.Application.Current.Resources);
        SetMonitoringState(MonitoringStatus.Foreground == FindResource("SuccessBrush"));
        RefreshNotifications();
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
        }
        catch { loadingDeliveryState = true; DeliveryEnabled.IsChecked = !enabled; loadingDeliveryState = false; EnrollmentStatus.Text = LocalizationManager.EffectiveLanguage == "ja" ? "送信設定を変更できませんでした。" : "Could not change delivery setting."; }
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
            var endpoint = value.RemoteAddress.Contains(':') ? $"[{value.RemoteAddress}]:{value.RemotePort}" : $"{value.RemoteAddress}:{value.RemotePort}";
            return string.IsNullOrWhiteSpace(value.RemoteHostname) ? endpoint : $"{value.RemoteHostname} ({endpoint})";
        }
    }
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
