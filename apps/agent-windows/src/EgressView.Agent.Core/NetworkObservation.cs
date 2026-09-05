namespace EgressView.Agent.Core;

public enum ObservationLayer
{
    Logical,
    VpnTransport,
}

public sealed record NetworkObservation(
    DateTimeOffset ObservedAt,
    int ProcessId,
    string Protocol,
    string LocalAddress,
    int LocalPort,
    string RemoteAddress,
    int RemotePort,
    long? BytesSent,
    long? BytesReceived,
    ObservationLayer Layer,
    string? InterfaceId,
    string Source,
    string? ProcessName = null);

public sealed record StartupFlow(
    string Protocol,
    string LocalAddress,
    int LocalPort,
    string RemoteAddress,
    int RemotePort,
    int ProcessId,
    string? ProcessName = null);

public sealed record HourlySummary(
    DateTimeOffset BucketStart,
    string Protocol,
    ObservationLayer Layer,
    long ObservationCount,
    long BytesSent,
    long BytesReceived,
    long BytesUnknown);

public sealed record CollectorSnapshot(
    string State,
    long Accepted,
    long Persisted,
    long QueueFullDrops,
    long PersistenceFailures,
    DateTimeOffset? LastObservedAt,
    DateTimeOffset? LastPersistedAt,
    int QueueCapacity,
    bool EtwSessionActive = false,
    long EtwEventsSeen = 0,
    long EtwEventsIgnored = 0,
    long InterfaceUnresolved = 0,
    // Inbound group datagrams left out on purpose. Not a collection gap.
    long InboundMulticastIgnored = 0,
    int EtwEventsLost = 0,
    string? CollectorError = null,
    string? PersistenceError = null,
    // How process names were arrived at. The counts say whether a nameless
    // observation is recoverable (the process was there and we lost it) or
    // not (it was already running before collection began).
    long NamesFromStartEvents = 0,
    long NamesFromCache = 0,
    long NamesNeverSeen = 0,
    long NamesExpired = 0,
    long NamesPidReuseRejected = 0,
    string? ProcessNameSourceError = null);

public enum StoreFailureKind
{
    Unknown,
    Corrupt,
    DiskFull,
    SchemaInvalid,
    SchemaTooNew,
}

public sealed class ObservationStoreException(StoreFailureKind kind, string message) : InvalidOperationException(message)
{
    public StoreFailureKind Kind { get; } = kind;
}
