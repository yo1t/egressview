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
    private int selectedDays = 7;
    private IReadOnlyList<RecentFlow> rawFlows = [];
    public ObservableCollection<FlowRow> RecentFlows { get; } = [];

    public MainWindow()
    {
        InitializeComponent();
        DataContext = this;
        SourceInitialized += (_, _) => NativeWindowTheme.Apply(this);
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
    private async void SevenDays_Click(object sender, RoutedEventArgs e) { selectedDays = 7; PeriodCaption.SetResourceReference(TextBlock.TextProperty, "Last7Days"); await RefreshNetworkAsync(); }
    private async void ThirtyDays_Click(object sender, RoutedEventArgs e) { selectedDays = 30; PeriodCaption.SetResourceReference(TextBlock.TextProperty, "Last30Days"); await RefreshNetworkAsync(); }

    private async Task RefreshAllAsync()
    {
        await RefreshStatusAsync();
        await RefreshNetworkAsync();
        await RefreshFlowsAsync();
        RefreshNotifications();
    }

    private Task RefreshVisibleAsync() => MainTabs.SelectedIndex switch
    {
        0 => RefreshNetworkAsync(),
        1 => RefreshFlowsAsync(),
        _ => RefreshStatusAsync(),
    };

    private async Task RefreshNetworkAsync()
    {
        try
        {
            var summaryResponse = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "summary", days = selectedDays }), lifetime.Token);
            using var summaryDocument = JsonDocument.Parse(summaryResponse);
            var summaries = summaryDocument.RootElement.GetProperty("data").Deserialize<List<HourlySummary>>() ?? [];
            Timeline.SetItems(summaries);
            ConnectionCount.Text = summaries.Sum(item => item.ObservationCount).ToString("N0");

            if (rawFlows.Count == 0) await RefreshFlowsAsync();
            ApplicationCount.Text = rawFlows.Select(item => item.ProcessName).Where(value => !string.IsNullOrWhiteSpace(value)).Distinct(StringComparer.OrdinalIgnoreCase).Count().ToString("N0");
            DestinationCount.Text = rawFlows.Select(item => (item.RemoteAddress, item.RemotePort)).Distinct().Count().ToString("N0");
            FlowCaption.Text = string.Format(CultureInfo.CurrentCulture, "{0:N0} {1} · {2:N0} {3}", ApplicationCount.Text == "—" ? 0 : int.Parse(ApplicationCount.Text, NumberStyles.Number), LocalizationManager.Text("Applications"), DestinationCount.Text == "—" ? 0 : int.Parse(DestinationCount.Text, NumberStyles.Number), LocalizationManager.Text("Destinations"));
        }
        catch (Exception exception) { FlowCaption.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
    }

    private async Task RefreshFlowsAsync()
    {
        try
        {
            var limit = SelectedLimit();
            rawFlows = await ReadFlowPageAsync(limit, 0);
            RecentFlows.Clear();
            foreach (var flow in rawFlows) RecentFlows.Add(new FlowRow(flow));
            LogStatus.Text = rawFlows.Count == 0 ? LocalizationManager.Text("NoConnections") : $"{rawFlows.Count:N0} {LocalizationManager.Text("Rows").ToLower(CultureInfo.CurrentCulture)}";
        }
        catch (Exception exception) { LogStatus.Text = $"{LocalizationManager.Text("CannotConnect")}: {exception.Message}"; }
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
        var from = now.AddDays(-selectedDays);
        var dialog = new Microsoft.Win32.SaveFileDialog { Filter = "CSV (*.csv)|*.csv", FileName = ObservationCsv.SuggestedFileName(now.AddDays(-selectedDays), now), AddExtension = true };
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
    public string Destination => value.RemoteAddress.Contains(':') ? $"[{value.RemoteAddress}]:{value.RemotePort}" : $"{value.RemoteAddress}:{value.RemotePort}";
    public string Protocol => value.Protocol;
    public string BytesReceivedText => FormatBytes(value.BytesReceived);
    public string BytesSentText => FormatBytes(value.BytesSent);
    public string Origin => value.Origin;
    private static string FormatBytes(long? bytes) => bytes is null ? "—" : bytes < 1024 ? $"{bytes} B" : bytes < 1_048_576 ? $"{bytes / 1024d:N1} KiB" : $"{bytes / 1_048_576d:N1} MiB";
}

internal sealed class NotificationRow(NotificationHistoryEntry value)
{
    public string DateText => value.Date.LocalDateTime.ToString("g");
    public string Kind => value.Kind;
    public string Title => value.Title;
    public string Body => value.Body;
}
