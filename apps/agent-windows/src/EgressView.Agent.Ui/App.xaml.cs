using System.Threading;
using System.Windows;
using Forms = System.Windows.Forms;

namespace EgressView.Agent.Ui;

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

    internal bool IsExiting { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ThemeManager.ApplySystemTheme(Resources);
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

        var window = new MainWindow();
        MainWindow = window;
        CreateTrayIcon();
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
        window.Show();
    }

    private void CreateTrayIcon()
    {
        var menu = new Forms.ContextMenuStrip();
        menu.Items.Add("開く / Open", null, (_, _) => Dispatcher.Invoke(ShowMainWindow));
        menu.Items.Add(new Forms.ToolStripSeparator());
        menu.Items.Add("UIを終了（監視は継続） / Exit UI", null, (_, _) => Dispatcher.Invoke(ExitUi));
        trayIcon = new Forms.NotifyIcon
        {
            Icon = System.Drawing.SystemIcons.Information,
            Text = "EgressView Agent — monitoring continues",
            ContextMenuStrip = menu,
            Visible = true,
        };
        trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowMainWindow);
    }

    private void ShowMainWindow()
    {
        if (MainWindow is null) return;
        MainWindow.Show();
        if (MainWindow.WindowState == WindowState.Minimized) MainWindow.WindowState = WindowState.Normal;
        MainWindow.Activate();
    }

    private void ExitUi()
    {
        IsExiting = true;
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        IsExiting = true;
        activationRegistration?.Unregister(null);
        exitRegistration?.Unregister(null);
        trayIcon?.Dispose();
        activationEvent?.Dispose();
        exitEvent?.Dispose();
        instanceMutex?.Dispose();
        base.OnExit(e);
    }
}
