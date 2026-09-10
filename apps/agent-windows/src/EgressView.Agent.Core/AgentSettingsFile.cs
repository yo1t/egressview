using System.Text.Json;
using System.Text.Json.Serialization;

namespace EgressView.Agent.Core;

public sealed record AgentSettingsFile(
    [property: JsonPropertyName("version")] int SchemaVersion,
    [property: JsonPropertyName("language")] string? Language = null,
    [property: JsonPropertyName("notificationsEnabled")] bool? NotificationsEnabled = null,
    [property: JsonPropertyName("notifyThreat")] bool? NotifyThreat = null,
    [property: JsonPropertyName("notifyMonitoring")] bool? NotifyMonitoring = null,
    [property: JsonPropertyName("notifyHubDelivery")] bool? NotifyHubDelivery = null,
    [property: JsonPropertyName("notifyThreatIntel")] bool? NotifyThreatIntel = null,
    [property: JsonPropertyName("notifyRecovery")] bool? NotifyRecovery = null,
    [property: JsonPropertyName("notificationDailyLimit")] int? NotificationDailyLimit = null,
    [property: JsonPropertyName("globeFrameRate")] int? GlobeFrameRate = null,
    [property: JsonPropertyName("periodMinutes")] int? PeriodMinutes = null,
    [property: JsonPropertyName("metric")] string? Metric = null,
    [property: JsonPropertyName("destinationUnit")] string? DestinationUnit = null,
    [property: JsonPropertyName("globeView")] string? GlobeView = null,
    [property: JsonPropertyName("retentionDays")] int? RetentionDays = null,
    [property: JsonPropertyName("automaticUpdateChecks")] bool? AutomaticUpdateChecks = null)
{
    public const int CurrentSchemaVersion = 1;
    public const int MaximumBytes = 1_048_576;

    public static byte[] Encode(AgentSettingsFile value)
    {
        Validate(value);
        return JsonSerializer.SerializeToUtf8Bytes(value, new JsonSerializerOptions { WriteIndented = true });
    }

    public static AgentSettingsFile Decode(ReadOnlySpan<byte> bytes)
    {
        if (bytes.Length is 0 or > MaximumBytes) throw new InvalidDataException("Settings file size is invalid.");
        try
        {
            var value = JsonSerializer.Deserialize<AgentSettingsFile>(bytes, new JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = false,
                UnmappedMemberHandling = System.Text.Json.Serialization.JsonUnmappedMemberHandling.Skip,
            }) ?? throw new InvalidDataException("Settings file is empty.");
            Validate(value);
            return value;
        }
        catch (JsonException exception) { throw new InvalidDataException("Settings file is not valid JSON.", exception); }
    }

    public static IReadOnlyList<string> PresentFields(AgentSettingsFile value)
    {
        var result = new List<string>();
        void Add(bool present, string name) { if (present) result.Add(name); }
        Add(value.Language is not null, nameof(Language));
        Add(value.NotificationsEnabled is not null, nameof(NotificationsEnabled));
        Add(value.NotifyThreat is not null, nameof(NotifyThreat));
        Add(value.NotifyMonitoring is not null, nameof(NotifyMonitoring));
        Add(value.NotifyHubDelivery is not null, nameof(NotifyHubDelivery));
        Add(value.NotifyThreatIntel is not null, nameof(NotifyThreatIntel));
        Add(value.NotifyRecovery is not null, nameof(NotifyRecovery));
        Add(value.NotificationDailyLimit is not null, nameof(NotificationDailyLimit));
        Add(value.GlobeFrameRate is not null, nameof(GlobeFrameRate));
        Add(value.PeriodMinutes is not null, nameof(PeriodMinutes));
        Add(value.Metric is not null, nameof(Metric));
        Add(value.DestinationUnit is not null, nameof(DestinationUnit));
        Add(value.GlobeView is not null, nameof(GlobeView));
        Add(value.RetentionDays is not null, nameof(RetentionDays));
        Add(value.AutomaticUpdateChecks is not null, nameof(AutomaticUpdateChecks));
        return result;
    }

    public static string SuggestedFileName(DateTimeOffset now) => $"egressview-agent-settings-{now.UtcDateTime:yyyyMMdd-HHmmss}.json";

    private static void Validate(AgentSettingsFile value)
    {
        if (value.SchemaVersion != CurrentSchemaVersion) throw new InvalidDataException("Unsupported settings schema version.");
        if (value.Language is not null && value.Language is not ("system" or "english" or "japanese")) Invalid(nameof(Language));
        if (value.NotificationDailyLimit is not null && value.NotificationDailyLimit is not (0 or 5 or 12 or 25)) Invalid(nameof(NotificationDailyLimit));
        if (value.GlobeFrameRate is not null && value.GlobeFrameRate is not (3 or 5 or 15)) Invalid(nameof(GlobeFrameRate));
        if (value.PeriodMinutes is not null && value.PeriodMinutes is not (60 or 360 or 1440 or 10080 or 43200)) Invalid(nameof(PeriodMinutes));
        if (value.Metric is not null && value.Metric is not ("connections" or "bytes")) Invalid(nameof(Metric));
        if (value.DestinationUnit is not null && value.DestinationUnit is not ("name" or "ip")) Invalid(nameof(DestinationUnit));
        if (value.GlobeView is not null && value.GlobeView is not ("globe" or "countries")) Invalid(nameof(GlobeView));
        if (value.RetentionDays is not null && !ObservationStore.AllowedRetentionDays.Contains(value.RetentionDays.Value)) Invalid(nameof(RetentionDays));
    }

    private static void Invalid(string field) => throw new InvalidDataException($"Invalid settings field: {field}.");
}
