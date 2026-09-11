using System.Threading;
using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using EgressView.Agent.Core;
using Forms = System.Windows.Forms;

namespace EgressView.Agent.Ui;

internal sealed record DiagnosticsSaveResult(string Path, bool ServiceReportIncluded);

public partial class App : System.Windows.Application
{
    private const string InstanceName = @"Local\EgressView.Agent.Ui";
    private const string ActivationName = @"Local\EgressView.Agent.Ui.Show";
    private const string ExitName = @"Local\EgressView.Agent.Ui.Exit";
    private Mutex? instanceMutex;
    private EventWaitHandle? activationEvent;
    private RegisteredWaitHandle? activationRegistration;
    private EventWaitHandle? exitEvent;
    private RegisteredWaitHandle? exitRegistration;
    private Forms.NotifyIcon? trayIcon;
    private Forms.ToolStripMenuItem? trayStatus;
    private Forms.ToolStripMenuItem? monitoringToggle;
    private Forms.ToolStripMenuItem? openItem;
    private Forms.ToolStripMenuItem? settingsItem;
    private Forms.ToolStripMenuItem? diagnosticsItem;
    private Forms.ToolStripMenuItem? aboutItem;
    private Forms.ToolStripMenuItem? checkUpdatesItem;
    private Forms.ToolStripMenuItem? installUpdateItem;
    private Forms.ToolStripMenuItem? exitItem;
    private readonly DispatcherTimer trayRefresh = new() { Interval = TimeSpan.FromSeconds(15) };
    internal MonitoringStatusTracker MonitoringStatus { get; } = new();
    internal LocalNotificationService Notifications { get; } = new();
    internal AgentUpdateController Updates { get; } = new();

    internal bool IsExiting { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ThemeManager.ApplySystemTheme(Resources);
        Microsoft.Win32.SystemEvents.UserPreferenceChanged += SystemThemeChanged;
        LocalizationManager.Apply(Resources);
        AgentStartupRegistration.InitializeDefault();
        activationEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ActivationName);
        exitEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ExitName);
        instanceMutex = new Mutex(true, InstanceName, out var firstInstance);
        if (!firstInstance)
        {
            if (e.Args.Contains("--exit-ui", StringComparer.Ordinal)) exitEvent.Set();
            else activationEvent.Set();
            Shutdown();
            return;
        }

        if (e.Args.Contains("--exit-ui", StringComparer.Ordinal))
        {
            Shutdown();
            return;
        }

        WindowsApplicationRestart.RegisterForInstallerUpdate();

        var window = new MainWindow();
        MainWindow = window;
        CreateTrayIcon();
        trayRefresh.Tick += async (_, _) =>
        {
            await RefreshTrayStateAsync();
            await RefreshDeliveryNotificationAsync();
        };
        trayRefresh.Start();
        activationRegistration = ThreadPool.RegisterWaitForSingleObject(
            activationEvent,
            (_, _) => Dispatcher.BeginInvoke(ShowMainWindow),
            null,
            Timeout.Infinite,
            false);
        exitRegistration = ThreadPool.RegisterWaitForSingleObject(
            exitEvent,
            (_, _) => Dispatcher.BeginInvoke(ExitUi),
            null,
            Timeout.Infinite,
            false);
        if (!e.Args.Contains("--tray", StringComparer.Ordinal)) window.Show();
        _ = RefreshTrayStateAsync();
        Updates.StateChanged += UpdateStateChanged;
        _ = Updates.RunIfDueAsync();
    }

    private void CreateTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        trayStatus = new Forms.ToolStripMenuItem { Enabled = false };
        menu.Items.Add(trayStatus);
        menu.Items.Add(new Forms.ToolStripSeparator());
        openItem = new Forms.ToolStripMenuItem("", null, (_, _) => Dispatcher.Invoke(() => ShowMainWindow()));
        settingsItem = new Forms.ToolStripMenuItem("", null, (_, _) => Dispatcher.Invoke(() => ShowMainWindow(5)));
        diagnosticsItem = new Forms.ToolStripMenuItem("", null, async (_, _) => await Dispatcher.InvokeAsync(SaveDiagnosticsAsync));
        aboutItem = new Forms.ToolStripMenuItem("", null, (_, _) => Dispatcher.Invoke(ShowAbout));
        checkUpdatesItem = new Forms.ToolStripMenuItem("", null, async (_, _) => await Dispatcher.InvokeAsync(CheckForUpdatesAsync));
        installUpdateItem = new Forms.ToolStripMenuItem("", null, async (_, _) => await Dispatcher.InvokeAsync(InstallUpdateAsync));
        menu.Items.Add(openItem);
        menu.Items.Add(settingsItem);
        menu.Items.Add(diagnosticsItem);
        menu.Items.Add(checkUpdatesItem);
        menu.Items.Add(installUpdateItem);
        menu.Items.Add(aboutItem);
        menu.Items.Add(new Forms.ToolStripSeparator());
        monitoringToggle = new Forms.ToolStripMenuItem();
        monitoringToggle.Click += async (_, _) => await Dispatcher.InvokeAsync(ToggleMonitoringAsync);
        menu.Items.Add(monitoringToggle);
        menu.Items.Add(new Forms.ToolStripSeparator());
        exitItem = new Forms.ToolStripMenuItem("", null, (_, _) => Dispatcher.Invoke(ExitUi));
        menu.Items.Add(exitItem);
        trayIcon = new Forms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Information,
            Text = "EgressView Agent — monitoring continues",
            ContextMenuStrip = menu,
            Visible = true,
        };
        trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowMainWindow);
        RefreshTrayText();
    }

    internal void ShowNotification(string title, string body) =>
        trayIcon?.ShowBalloonTip(5_000, title, body, Forms.ToolTipIcon.Info);

    private void ShowMainWindow() => ShowMainWindow(null);

    private void ShowMainWindow(int? tabIndex)
    {
        if (MainWindow is null) return;
        if (tabIndex is not null && MainWindow is MainWindow window) window.SelectTab(tabIndex.Value);
        MainWindow.Show();
        if (MainWindow.WindowState == WindowState.Minimized) MainWindow.WindowState = WindowState.Normal;
        MainWindow.Activate();
    }

    internal void UpdateTrayState(bool enabled, bool healthy, string? issueCode = null, string? issueAction = null)
    {
        MonitoringStatus.Confirm(enabled, healthy, DateTimeOffset.Now, issueCode, issueAction);
        RefreshTrayText();
    }

    internal void UpdateTrayUnavailable()
    {
        MonitoringStatus.MarkUnavailable();
        RefreshTrayText();
    }

    internal void RefreshTrayText()
    {
        if (trayIcon is null || trayStatus is null || monitoringToggle is null || openItem is null || settingsItem is null ||
            diagnosticsItem is null || aboutItem is null || checkUpdatesItem is null || installUpdateItem is null || exitItem is null) return;
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var state = MonitoringStatus.Current;
        trayStatus.Text = state.Kind switch
        {
            MonitoringPresentationKind.Monitoring => ja ? "状態: 監視中" : "Status: Monitoring",
            MonitoringPresentationKind.Stopped => ja ? "状態: 監視停止" : "Status: Monitoring stopped",
            MonitoringPresentationKind.NeedsAttention => ja ? "状態: 要確認" : "Status: Needs attention",
            MonitoringPresentationKind.Unavailable => state.LastConfirmedAt is { } at
                ? $"{(ja ? "状態取得不可" : "Status unavailable")} · {at.ToLocalTime():g}"
                : (ja ? "状態取得不可" : "Status unavailable"),
            _ => ja ? "状態: 確認中" : "Status: Checking",
        };
        trayStatus.ToolTipText = state.Kind switch
        {
            MonitoringPresentationKind.NeedsAttention when !string.IsNullOrWhiteSpace(state.IssueCode) =>
                $"{state.IssueCode}{(string.IsNullOrWhiteSpace(state.IssueAction) ? string.Empty : $": {state.IssueAction}")}",
            MonitoringPresentationKind.Unavailable when state.LastConfirmedAt is { } at =>
                $"{(ja ? "最終確認" : "Last confirmed")} {at.ToLocalTime():g}",
            _ => string.Empty,
        };
        openItem.Text = ja ? "EgressView Agentを開く" : "Open EgressView Agent";
        settingsItem.Text = ja ? "設定" : "Settings";
        diagnosticsItem.Text = ja ? "診断を保存…" : "Save diagnostics…";
        checkUpdatesItem.Text = Updates.State.Kind is UpdateStateKind.Checking or UpdateStateKind.Downloading
            ? (ja ? "更新を確認中…" : "Checking for updates…") : (ja ? "更新を確認…" : "Check for updates…");
        checkUpdatesItem.Enabled = Updates.State.Kind is not UpdateStateKind.Checking and not UpdateStateKind.Downloading and not UpdateStateKind.Launching;
        installUpdateItem.Text = ja ? "検証済み更新をインストール…" : "Install verified update…";
        installUpdateItem.Enabled = Updates.CanInstall;
        installUpdateItem.Visible = Updates.CanInstall;
        aboutItem.Text = ja ? "EgressView Agentについて" : "About EgressView Agent";
        monitoringToggle.Text = state.Kind == MonitoringPresentationKind.Stopped
            ? (ja ? "監視を開始…" : "Start monitoring…")
            : (ja ? "監視を停止…" : "Stop monitoring…");
        monitoringToggle.Enabled = state.Kind is not MonitoringPresentationKind.Checking and not MonitoringPresentationKind.Unavailable;
        exitItem.Text = ja ? "UIを終了（監視は継続）" : "Exit UI (monitoring continues)";
        trayIcon.Icon = state.Kind switch
        {
            MonitoringPresentationKind.Monitoring => System.Drawing.SystemIcons.Information,
            MonitoringPresentationKind.Stopped => System.Drawing.SystemIcons.Application,
            MonitoringPresentationKind.NeedsAttention => System.Drawing.SystemIcons.Error,
            MonitoringPresentationKind.Unavailable => System.Drawing.SystemIcons.Warning,
            _ => System.Drawing.SystemIcons.Application,
        };
        trayIcon.Text = trayStatus.Text.Replace("状態: ", "EgressView Agent — ", StringComparison.Ordinal)
            .Replace("Status: ", "EgressView Agent — ", StringComparison.Ordinal);
    }

    private void UpdateStateChanged(object? sender, EventArgs e) => Dispatcher.BeginInvoke(() =>
    {
        RefreshTrayText();
        if (MainWindow is MainWindow window) window.RefreshUpdateStatus();
    });

    private async Task CheckForUpdatesAsync()
    {
        ShowMainWindow(5);
        if (MainWindow is MainWindow window) window.SelectSettingsSection("updates");
        await Updates.CheckNowAsync();
    }

    private async Task InstallUpdateAsync()
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var message = ja
            ? "署名とSHA-256を再検証してインストーラーを起動します。監視は一時停止し、完了後に自動再開します。続けますか？"
            : "The signature and SHA-256 will be verified again before Windows Installer starts. Monitoring pauses briefly and resumes after setup. Continue?";
        if (System.Windows.MessageBox.Show(message, "EgressView Agent", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
        if (!await Updates.LaunchInstallerAsync())
            System.Windows.MessageBox.Show(ja ? "検証済みインストーラーを起動できませんでした。" : "Could not launch the verified installer.",
                "EgressView Agent", MessageBoxButton.OK, MessageBoxImage.Error);
    }

    private async Task RefreshTrayStateAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"status"}""");
            using var document = JsonDocument.Parse(response);
            var data = document.RootElement.GetProperty("data");
            var enabled = !data.TryGetProperty("monitoringEnabled", out var flag) || flag.GetBoolean();
            var hasActiveCoverage = data.GetProperty("coverage").GetProperty("active").GetInt64() > 0;
            var health = data.GetProperty("health");
            var healthy = health.GetProperty("status").GetString() == "healthy";
            string? issueCode = null;
            string? issueAction = null;
            if (health.TryGetProperty("issues", out var issues) && issues.ValueKind == JsonValueKind.Array && issues.GetArrayLength() > 0)
            {
                var first = issues[0];
                issueCode = first.TryGetProperty("code", out var code) ? code.GetString() : null;
                issueAction = first.TryGetProperty("action", out var action) ? action.GetString() : null;
            }
            UpdateTrayState(enabled, healthy, issueCode, issueAction);
            if (MainWindow is MainWindow window)
                window.ApplyMonitoringStatusFromTray(enabled, healthy, hasActiveCoverage, issueCode, issueAction);
        }
        catch
        {
            UpdateTrayUnavailable();
            if (MainWindow is MainWindow window)
                window.ApplyMonitoringUnavailableFromTray(MonitoringStatus.Current.LastConfirmedAt);
        }
    }

    private async Task RefreshDeliveryNotificationAsync()
    {
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"delivery-status"}""");
            using var document = JsonDocument.Parse(response);
            var data = document.RootElement.GetProperty("data");
            static DateTimeOffset? DateValue(JsonElement source, string property) =>
                source.TryGetProperty(property, out var value) && value.ValueKind == JsonValueKind.String &&
                DateTimeOffset.TryParse(value.GetString(), out var parsed) ? parsed : null;
            Notifications.ObserveHubDelivery(new(
                DateTimeOffset.Now,
                data.GetProperty("enrolled").GetBoolean() && data.GetProperty("enabled").GetBoolean(),
                data.GetProperty("state").GetString() ?? "idle",
                data.GetProperty("pending").GetInt64(),
                DateValue(data, "oldestPendingAt"),
                DateValue(data, "lastAcknowledgedAt")),
                ShowNotification);
        }
        catch { /* Status availability is represented separately; it is not a Hub outage. */ }
    }

    private async Task ToggleMonitoringAsync()
    {
        if (monitoringToggle is null) return;
        var enable = MonitoringStatus.Current.Kind == MonitoringPresentationKind.Stopped;
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var action = enable ? (ja ? "監視を開始しますか？" : "Start monitoring?") :
            (ja ? "監視を停止しますか？\n\nUIとHub送信サービスは動作を続けます。" : "Stop monitoring?\n\nThe UI and Hub delivery service will keep running.");
        if (System.Windows.MessageBox.Show(action, "EgressView Agent", MessageBoxButton.OKCancel, MessageBoxImage.Question) != MessageBoxResult.OK) return;
        monitoringToggle.Enabled = false;
        try
        {
            var request = JsonSerializer.Serialize(new { v = 1, op = "set-monitoring-enabled", enabled = enable });
            var response = await AgentIpcClient.RequestAsync(request);
            using var document = JsonDocument.Parse(response);
            if (document.RootElement.GetProperty("status").GetString() != "ok") throw new InvalidOperationException();
            UpdateTrayState(enable, enable);
            if (MainWindow is MainWindow window) await window.RefreshStatusFromTrayAsync();
        }
        catch
        {
            System.Windows.MessageBox.Show(ja ? "監視状態を変更できませんでした。" : "Could not change monitoring state.",
                "EgressView Agent", MessageBoxButton.OK, MessageBoxImage.Error);
            await RefreshTrayStateAsync();
        }
        finally
        {
            monitoringToggle.Enabled = MonitoringStatus.Current.Kind is not MonitoringPresentationKind.Checking and not MonitoringPresentationKind.Unavailable;
        }
    }

    internal async Task<DiagnosticsSaveResult?> SaveDiagnosticsAsync()
    {
        var ja = LocalizationManager.EffectiveLanguage == "ja";
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Filter = "ZIP (*.zip)|*.zip",
            FileName = $"egressview-diagnostics-{DateTimeOffset.Now:yyyyMMdd-HHmmss}.zip",
            AddExtension = true,
        };
        if (dialog.ShowDialog(MainWindow) != true) return null;
        try
        {
            string report;
            var serviceReport = true;
            try
            {
                var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"diagnostics"}""");
                using var document = JsonDocument.Parse(response);
                if (document.RootElement.GetProperty("status").GetString() != "ok") throw new InvalidOperationException("diagnostics-rejected");
                report = document.RootElement.GetProperty("data").GetRawText();
            }
            catch (Exception exception)
            {
                serviceReport = false;
                report = DiagnosticsReport.CreateFallback(DiagnosticsReport.CurrentVersion, exception.GetType().Name);
            }
            DiagnosticsBundle.Create(dialog.FileName, report);
            var message = serviceReport
                ? (ja ? "診断を保存しました。" : "Diagnostics saved.")
                : (ja ? "Serviceへ接続できないため、利用可能な診断だけを保存しました。Windows Event Viewerの確認手順も含まれます。" : "The service was unavailable, so a limited diagnostic was saved with Windows Event Viewer instructions.");
            System.Windows.MessageBox.Show(message, "EgressView Agent", MessageBoxButton.OK, serviceReport ? MessageBoxImage.Information : MessageBoxImage.Warning);
            return new(dialog.FileName, serviceReport);
        }
        catch
        {
            System.Windows.MessageBox.Show(ja ? "診断を保存できませんでした。" : "Could not save diagnostics.", "EgressView Agent", MessageBoxButton.OK, MessageBoxImage.Error);
            return null;
        }
    }

    internal async void ShowAbout()
    {
        AgentBuildIdentity? service = null;
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"status"}""");
            using var document = JsonDocument.Parse(response);
            var build = document.RootElement.GetProperty("data").GetProperty("build");
            service = new(build.GetProperty("version").GetString() ?? "unknown",
                build.TryGetProperty("informationalVersion", out var detail) ? detail.GetString() ?? "unknown" : "unknown");
        }
        catch { /* About remains useful when the service is unavailable. */ }
        var dialog = new AboutWindow(AboutWindow.CurrentUi(), service) { Owner = MainWindow };
        dialog.ShowDialog();
    }

    private void ExitUi()
    {
        IsExiting = true;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        IsExiting = true;
        Microsoft.Win32.SystemEvents.UserPreferenceChanged -= SystemThemeChanged;
        trayRefresh.Stop();
        Updates.StateChanged -= UpdateStateChanged;
        Updates.Dispose();
        activationRegistration?.Unregister(null);
        exitRegistration?.Unregister(null);
        trayIcon?.Dispose();
        activationEvent?.Dispose();
        exitEvent?.Dispose();
        instanceMutex?.Dispose();
        base.OnExit(e);
    }

    private void SystemThemeChanged(object sender, Microsoft.Win32.UserPreferenceChangedEventArgs e)
    {
        if (e.Category is not Microsoft.Win32.UserPreferenceCategory.Color and
            not Microsoft.Win32.UserPreferenceCategory.General) return;
        Dispatcher.BeginInvoke(() => ThemeManager.ApplySystemTheme(Resources));
    }

}
