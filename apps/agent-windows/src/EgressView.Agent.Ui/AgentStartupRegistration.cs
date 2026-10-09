using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using EgressView.Agent.Core;
using Microsoft.Win32;

namespace EgressView.Agent.Ui;

/// Starts the window in the notification area when the user signs in.
///
/// Through a Task Scheduler logon task since P3-106: the Run value it used to
/// be was started by Explorer 28.5 s after sign-in, while everything the
/// window needed was ready before sign-in. The Run value is kept only as the
/// fallback for a PC where the task cannot be registered -- a policy that
/// forbids it, or a Task Scheduler that is off -- so that starting at sign-in
/// late is what happens there, not not starting at all.
internal static class AgentStartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string PreferenceKey = @"Software\EgressView\Agent";
    private const string ValueName = "EgressView Agent";

    internal static bool IsEnabled => TaskExists() || RunValuePresent();

    internal static void InitializeDefault()
    {
        try
        {
            using var preferences = Registry.CurrentUser.CreateSubKey(PreferenceKey);
            if (preferences.GetValue("StartupPreferenceInitialized") is null)
            {
                SetEnabled(true);
                preferences.SetValue("StartupPreferenceInitialized", 1, RegistryValueKind.DWord);
                return;
            }

            if (preferences.GetValue("StartupUiEnabled") is int enabled)
                Apply(enabled != 0);
            else
                preferences.SetValue("StartupUiEnabled", IsEnabled ? 1 : 0, RegistryValueKind.DWord);
        }
        catch { /* A locked-down profile must not prevent the UI from opening. */ }
    }

    internal static void SetEnabled(bool enabled)
    {
        using var preferences = Registry.CurrentUser.CreateSubKey(PreferenceKey);
        preferences.SetValue("StartupUiEnabled", enabled ? 1 : 0, RegistryValueKind.DWord);
        preferences.SetValue("StartupPreferenceInitialized", 1, RegistryValueKind.DWord);
        Apply(enabled);
    }

    /// Before the Agent is uninstalled: a task left behind would try to start
    /// a window that no longer exists at every sign-in. The preference is
    /// kept, so if the uninstall is cancelled the next start registers it
    /// again.
    internal static void RemoveForUninstall()
    {
        RunSchtasks("/Delete", "/TN", StartupTask.Name, "/F");
        SetRunValue(false);
    }

    /// Registered again on every start while enabled, so a PC that had the
    /// Run value moves to the task on its first start after updating, and the
    /// task always names the executable that is installed now.
    private static void Apply(bool enabled)
    {
        if (!enabled)
        {
            RunSchtasks("/Delete", "/TN", StartupTask.Name, "/F");
            SetRunValue(false);
            return;
        }
        var path = Environment.ProcessPath ?? throw new InvalidOperationException("The UI executable path is unavailable.");
        var registered = RegisterTask(path);
        // Never both: the second would start a second window at sign-in,
        // which the single-instance check then turns into a flash.
        SetRunValue(!registered);
    }

    private static bool RegisterTask(string path)
    {
        var user = WindowsIdentity.GetCurrent().User?.Value;
        if (user is null) return false;
        var file = Path.Combine(Path.GetTempPath(), $"egressview-startup-{Guid.NewGuid():N}.xml");
        try
        {
            // UTF-16, as the declaration in the XML says: schtasks reads the
            // file in the encoding it declares.
            File.WriteAllText(file, StartupTask.Xml(user, path), Encoding.Unicode);
            return RunSchtasks("/Create", "/TN", StartupTask.Name, "/XML", file, "/F") == 0;
        }
        catch { return false; }
        finally { try { File.Delete(file); } catch { } }
    }

    private static bool TaskExists() => RunSchtasks("/Query", "/TN", StartupTask.Name) == 0;

    private static int RunSchtasks(params string[] arguments)
    {
        try
        {
            var start = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, "schtasks.exe"))
            {
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            foreach (var argument in arguments) start.ArgumentList.Add(argument);
            using var process = Process.Start(start);
            if (process is null) return -1;
            process.StandardOutput.ReadToEnd();
            process.StandardError.ReadToEnd();
            if (!process.WaitForExit(15_000)) { try { process.Kill(); } catch { } return -1; }
            return process.ExitCode;
        }
        catch { return -1; }
    }

    private static bool RunValuePresent()
    {
        try { return Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue(ValueName) is string value && value.Length > 0; }
        catch { return false; }
    }

    private static void SetRunValue(bool enabled)
    {
        try
        {
            using var key = Registry.CurrentUser.CreateSubKey(RunKey);
            if (enabled)
            {
                var path = Environment.ProcessPath ?? throw new InvalidOperationException("The UI executable path is unavailable.");
                key.SetValue(ValueName, $"\"{path}\" --tray", RegistryValueKind.String);
            }
            else key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
        catch { /* The task, if registered, is what counts. */ }
    }
}
