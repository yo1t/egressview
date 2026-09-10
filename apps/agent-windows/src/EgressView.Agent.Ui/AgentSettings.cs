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
        get => int.TryParse(Read("NotificationDailyLimit"), out var value) && value is 0 or 5 or 12 or 25 ? value : 12;
        set => Write("NotificationDailyLimit", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    internal static bool NotificationCategoryEnabled(string kind) => kind switch
    {
        "Threat" => ReadBool("NotifyThreat", true),
        "Monitoring" => ReadBool("NotifyMonitoring", true),
        "HubDelivery" => ReadBool("NotifyHubDelivery", false),
        "ThreatIntel" => ReadBool("NotifyThreatIntel", true),
        "Recovery" => ReadBool("NotifyRecovery", true),
        _ => true,
    };

    internal static void SetNotificationCategory(string kind, bool enabled) =>
        Write(kind switch { "Threat" => "NotifyThreat", "Monitoring" => "NotifyMonitoring", "HubDelivery" => "NotifyHubDelivery", "ThreatIntel" => "NotifyThreatIntel", "Recovery" => "NotifyRecovery", _ => throw new ArgumentOutOfRangeException(nameof(kind)) }, enabled ? "1" : "0");

    internal static int GlobeFrameRate
    {
        get => int.TryParse(Read("GlobeFrameRate"), out var value) && value is 3 or 5 or 15 ? value : 5;
        set => Write("GlobeFrameRate", value.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    internal static string GlobeSpinSpeed
    {
        get => Read("GlobeSpinSpeed") is { } value && value is "slow" or "fast" ? value : "normal";
        set { if (value is "slow" or "normal" or "fast") Write("GlobeSpinSpeed", value); }
    }

    internal static string AiProvider
    {
        get => Read("AiProvider") is "OpenAI" or "Anthropic" ? Read("AiProvider")! : "Ollama";
        set { if (value is "Ollama" or "OpenAI" or "Anthropic") Write("AiProvider", value); }
    }

    internal static string AiModel(string provider) => Read($"AiModel{provider}") ?? "";
    internal static void SetAiModel(string provider, string value) => Write($"AiModel{provider}", value.Length <= 200 ? value : value[..200]);

    internal static string OllamaEndpoint
    {
        get => Read("OllamaEndpoint") ?? "http://127.0.0.1:11434";
        set => Write("OllamaEndpoint", value);
    }

    internal static bool AiEnabled(string provider) => ReadBool($"AiEnabled{provider}", false);
    internal static void SetAiEnabled(string provider, bool value) => Write($"AiEnabled{provider}", value ? "1" : "0");
    internal static bool AiCloudConsent(string provider) => ReadBool($"AiCloudConsent{provider}", false);
    internal static void SetAiCloudConsent(string provider, bool value) => Write($"AiCloudConsent{provider}", value ? "1" : "0");

    internal static string SettingsSection
    {
        get => Read("SettingsSection") is { } value && value is "general" or "notifications" or "enrichment" or "ai" or "history" or "diagnostics" or "updates" or "hub" or "uninstall" ? value : "general";
        set { if (value is "general" or "notifications" or "enrichment" or "ai" or "history" or "diagnostics" or "updates" or "hub" or "uninstall") Write("SettingsSection", value); }
    }

    internal static bool AutomaticUpdateChecks
    {
        get => ReadBool("AutomaticUpdateChecks", true);
        set => Write("AutomaticUpdateChecks", value ? "1" : "0");
    }

    internal static int PeriodMinutes
    {
        get => int.TryParse(Read("PeriodMinutes"), out var value) && value is 60 or 360 or 1440 or 10080 or 43200 ? value : 10080;
        set { if (value is 60 or 360 or 1440 or 10080 or 43200) Write("PeriodMinutes", value.ToString(System.Globalization.CultureInfo.InvariantCulture)); }
    }

    internal static string Metric
    {
        get => Read("Metric") is "bytes" ? "bytes" : "connections";
        set { if (value is "connections" or "bytes") Write("Metric", value); }
    }

    internal static string DestinationUnit
    {
        get => Read("DestinationUnit") is "ip" ? "ip" : "name";
        set { if (value is "name" or "ip") Write("DestinationUnit", value); }
    }

    internal static string GlobeView
    {
        get => Read("GlobeView") is "countries" ? "countries" : "globe";
        set { if (value is "globe" or "countries") Write("GlobeView", value); }
    }

    internal static DateTimeOffset? LastUpdateCheck
    {
        get => DateTimeOffset.TryParse(Read("LastUpdateCheck"), System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.RoundtripKind, out var value) ? value : null;
        set => Write("LastUpdateCheck", value?.ToString("O", System.Globalization.CultureInfo.InvariantCulture) ?? "");
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

    private static bool ReadBool(string name, bool fallback) => Read(name) is { } value ? value != "0" : fallback;

    private static void Write(string name, string value)
    {
        try { Registry.CurrentUser.CreateSubKey(KeyPath).SetValue(name, value); }
        catch { /* A locked-down profile must not stop monitoring or the UI. */ }
    }
}
