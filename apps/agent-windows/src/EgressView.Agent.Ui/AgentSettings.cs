using Microsoft.Win32;

namespace EgressView.Agent.Ui;

internal enum AgentLanguage { System, English, Japanese }

internal static class AgentSettings
{
    private const string KeyPath = @"Software\EgressView\Agent";

    internal static AgentLanguage Language
    {
        get => Enum.TryParse<AgentLanguage>(Read("Language"), out var value) ? value : AgentLanguage.System;
        set => Write("Language", value.ToString());
    }

    internal static bool NotificationsEnabled
    {
        get => Read("NotificationsEnabled") is not "0";
        set => Write("NotificationsEnabled", value ? "1" : "0");
    }

    internal static int NotificationDailyLimit
    {
        get => int.TryParse(Read("NotificationDailyLimit"), out var value) && value is 5 or 10 or 20 ? value : 10;
        set => Write("NotificationDailyLimit", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    internal static int GlobeFrameRate
    {
        get => int.TryParse(Read("GlobeFrameRate"), out var value) && value is 3 or 5 or 15 ? value : 5;
        set => Write("GlobeFrameRate", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    internal static string SettingsSection
    {
        get => Read("SettingsSection") is { } value && value is "general" or "notifications" or "hub" ? value : "general";
        set { if (value is "general" or "notifications" or "hub") Write("SettingsSection", value); }
    }

    internal static double WindowWidth
    {
        get => ReadDimension("WindowWidth", 1440, 1020, 7680);
        set => Write("WindowWidth", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    internal static double WindowHeight
    {
        get => ReadDimension("WindowHeight", 900, 700, 4320);
        set => Write("WindowHeight", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    private static double ReadDimension(string name, double fallback, double minimum, double maximum) =>
        double.TryParse(Read(name), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var value)
            && value >= minimum && value <= maximum ? value : fallback;

    private static string? Read(string name)
    {
        try { return Registry.CurrentUser.OpenSubKey(KeyPath)?.GetValue(name)?.ToString(); }
        catch { return null; }
    }

    private static void Write(string name, string value)
    {
        try { Registry.CurrentUser.CreateSubKey(KeyPath).SetValue(name, value); }
        catch { /* A locked-down profile must not stop monitoring or the UI. */ }
    }
}
