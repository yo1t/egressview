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
    string? ProcessName = null,
    string? RemoteHostname = null);

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

public sealed record RecentFlow(
    DateTimeOffset FirstSeen,
    DateTimeOffset LastSeen,
    string Protocol,
    string LocalAddress,
    int LocalPort,
    string RemoteAddress,
    int RemotePort,
    int ProcessId,
    string? ProcessName,
    long? BytesSent,
    long? BytesReceived,
    ObservationLayer Layer,
    string? InterfaceId,
    string Origin,
    string? RemoteHostname = null,
    string? CountryCode = null);

public sealed record GeoLocation(string Ip, double Latitude, double Longitude, string? CountryCode, string? City);
public sealed record GeoCacheState(string? ETag, DateTimeOffset? FetchedAt, long LocationCount);

public sealed record GlobePoint(double Latitude, double Longitude, string? CountryCode, string? City,
    long Connections, long Bytes);

public sealed record CountryHistoryRow(string CountryCode, long Connections,
    DateTimeOffset FirstObservedAt, DateTimeOffset LastObservedAt);

public sealed record AppDestinationAggregate(
    string Application, string Destination, string DestinationName, long Connections, long Bytes, long ConnectionsWithoutBytes);

public sealed record AppTimelineAggregate(
    int Bucket, string Application, long Connections, long Bytes, long ConnectionsWithoutBytes);

public sealed record PeriodAnalysis(
    DateTimeOffset From, DateTimeOffset To, long Connections, int Applications, int Destinations,
    long Bytes, long ConnectionsWithoutBytes, double CoverageRatio, DateTimeOffset? MonitoringStartedAt,
    long StoredFlows, IReadOnlyList<AppDestinationAggregate> Links, IReadOnlyList<AppTimelineAggregate> Timeline)
{
    public long StorageBytes { get; init; }
}

public sealed record ThreatIndicator(string Kind, string Value, string? Source, string? Tag, string Confidence);
public sealed record ThreatCacheState(string Availability, string? ETag, DateTimeOffset? FetchedAt, long IndicatorCount);
public sealed record ThreatFinding(string Destination, string Address, string? RequestedName, string Application,
    long Connections, long Bytes, long ConnectionsWithoutBytes, DateTimeOffset FirstSeen, DateTimeOffset LastSeen,
    string IndicatorKind, string MatchedValue, string? Source, string? Tag, string Confidence);
public sealed record ThreatReport(string Availability, long IndicatorCount, DateTimeOffset? FetchedAt,
    int CheckedDestinations, IReadOnlyList<ThreatFinding> Findings)
{
    public int DomainCheckedDestinations { get; init; }
    public int DomainUncheckedDestinations { get; init; }
}

public sealed record RetentionMaintenanceResult(long ObservationsDeleted, long FlowsDeleted,
    long HourlySummariesDeleted, long CoverageSessionsDeleted, long ChartSummariesDeleted = 0)
{
    public long TotalDeleted => ObservationsDeleted + FlowsDeleted + HourlySummariesDeleted + CoverageSessionsDeleted + ChartSummariesDeleted;
    public bool MayHaveMore(int batchSize) => ObservationsDeleted == batchSize || FlowsDeleted == batchSize ||
        HourlySummariesDeleted == batchSize || CoverageSessionsDeleted == batchSize || ChartSummariesDeleted == batchSize;
}

public sealed record LocalHistoryStatus(int RetentionDays, int RawDays, long StorageBytes,
    DateTimeOffset? OldestRawAt, DateTimeOffset? OldestAggregateAt,
    DateTimeOffset? LastCleanupAt, DateTimeOffset NextCleanupAt);

public sealed record LocalHistoryDeletionResult(long ObservationsDeleted, long FlowsDeleted,
    long HourlySummariesDeleted, long ChartSummariesDeleted, long CoverageSessionsDeleted)
{
    public long TotalDeleted => ObservationsDeleted + FlowsDeleted + HourlySummariesDeleted + ChartSummariesDeleted + CoverageSessionsDeleted;
}

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
    long NamesNeverSeenAtStartup = 0,
    long NamesNeverSeenAfterStartup = 0,
    long NamesNeverSeenAfterStartProbeMiss = 0,
    long NamesNeverSeenWithoutStartEvent = 0,
    long NamesInvalidProcessId = 0,
    long NamesExpired = 0,
    long NamesPidReuseRejected = 0,
    int NamesDeferredPending = 0,
    long NamesDeferred = 0,
    long NamesRecoveredFromStop = 0,
    long NamesDeferredExpired = 0,
    long NamesDeferredOverflow = 0,
    string? ProcessNameSourceError = null,
    long HostnamesResolved = 0,
    long HostnamesUnavailable = 0,
    long DnsEventsSeen = 0,
    string? HostnameSourceError = null);

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
