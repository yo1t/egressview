using Microsoft.Win32;

namespace EgressView.Agent.Ui;

internal static class AgentStartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string PreferenceKey = @"Software\EgressView\Agent";
    private const string ValueName = "EgressView Agent";

    internal static bool IsEnabled
    {
        get
        {
            try { return Registry.CurrentUser.OpenSubKey(RunKey)?.GetValue(ValueName) is string value && value.Length > 0; }
            catch { return false; }
        }
    }

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
                ApplyRunValue(enabled != 0);
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
        ApplyRunValue(enabled);
    }

    private static void ApplyRunValue(bool enabled)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        if (enabled)
        {
            var path = Environment.ProcessPath ?? throw new InvalidOperationException("The UI executable path is unavailable.");
            key.SetValue(ValueName, $"\"{path}\" --tray", RegistryValueKind.String);
        }
        else key.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
