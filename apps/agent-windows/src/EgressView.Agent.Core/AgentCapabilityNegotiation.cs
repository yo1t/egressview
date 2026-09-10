namespace EgressView.Agent.Core;

public sealed record AgentHubCapabilities(
    IReadOnlyList<int> SchemaVersions,
    int? MaxObservationsPerBatch = null,
    int? MaxBodyBytes = null,
    int? RequestsPerMinute = null,
    IReadOnlyList<string>? Compression = null,
    IReadOnlyList<string>? ObservationFields = null);

public enum AgentCapabilityOutcomeKind { Agreed, Unknown, Incompatible }

public sealed record AgentCapabilityOutcome(AgentCapabilityOutcomeKind Kind, int SchemaVersion,
    int BatchSize, bool IncludeRemoteHostname);

public sealed record DeliveryCapabilityStatus(string State, DateTimeOffset? CheckedAt = null,
    int? StatusCode = null, int? SchemaVersion = null, int? BatchSize = null,
    bool RemoteHostnameAccepted = false, string? Failure = null);

public static class AgentCapabilityNegotiation
{
    public const int CurrentSchemaVersion = 1;
    public const int AgentBatchLimit = 200;

    public static AgentCapabilityOutcome Decide(AgentHubCapabilities? capabilities)
    {
        if (capabilities is null)
            return new(AgentCapabilityOutcomeKind.Unknown, CurrentSchemaVersion, AgentBatchLimit, false);

        if (capabilities.SchemaVersions?.Contains(CurrentSchemaVersion) != true)
            return new(AgentCapabilityOutcomeKind.Incompatible, CurrentSchemaVersion, AgentBatchLimit, false);

        var batchSize = capabilities.MaxObservationsPerBatch is > 0 and < AgentBatchLimit
            ? capabilities.MaxObservationsPerBatch.Value : AgentBatchLimit;
        var hostname = capabilities.ObservationFields?.Contains("remoteHostname", StringComparer.Ordinal) == true;
        return new(AgentCapabilityOutcomeKind.Agreed, CurrentSchemaVersion, batchSize, hostname);
    }
}
