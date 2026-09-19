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

public enum RunComponent { Service, Ui }

/// One run of one of the agent's two processes, and how it ended.
///
/// <param name="Ending">running, clean, system-shutdown, unexpected, or
/// faulted. "unexpected" is decided by the next start finding this one still
/// marked running, which is the only way a process that died can be described
/// at all -- and why "system-shutdown" exists: without it, every restart of
/// the machine reads as one more crash.</param>
/// <param name="Fault">The exception type name, when one was caught. Never a
/// message: those carry paths, host names and destinations.</param>
public sealed record AgentRun(RunComponent Component, string Version, DateTimeOffset StartedAt,
    DateTimeOffset? HeartbeatAt, DateTimeOffset? EndedAt, string Ending, string? Fault);
/// A page of the log with its place in the event stream.
///
/// <param name="Cursor">The newest event this page accounts for.</param>
/// <param name="More">Whether events after this page were left unread, so the
/// reader can say so rather than presenting a fraction as the whole.</param>
public sealed record ObservationPage(long Cursor, bool More, IReadOnlyList<RecentFlow> Rows);

public sealed record GeoLocation(string Ip, double Latitude, double Longitude, string? CountryCode, string? City);
public sealed record GeoCacheState(string? ETag, DateTimeOffset? FetchedAt, long LocationCount);

public sealed record GlobePoint(double Latitude, double Longitude, string? CountryCode, string? City,
    long Connections, long Bytes);

public sealed record CountryHistoryRow(string CountryCode, long Connections,
    DateTimeOffset FirstObservedAt, DateTimeOffset LastObservedAt, string? RecentApplication = null);

public sealed record AppDestinationAggregate(
    string Application, string Destination, string DestinationName, long Connections, long Bytes, long ConnectionsWithoutBytes);

public sealed record AppTimelineAggregate(
    int Bucket, string Application, long Connections, long Bytes, long ConnectionsWithoutBytes);

public sealed record SleepPeriod(DateTimeOffset Start, DateTimeOffset End);

public sealed record PeriodAnalysis(
    DateTimeOffset From, DateTimeOffset To, long Connections, int Applications, int Destinations,
    long Bytes, long ConnectionsWithoutBytes, double CoverageRatio, DateTimeOffset? MonitoringStartedAt,
    long StoredFlows, IReadOnlyList<AppDestinationAggregate> Links, IReadOnlyList<AppTimelineAggregate> Timeline)
{
    public long StorageBytes { get; init; }

    /// Sent and received kept apart, because they answer different questions.
    /// "How much left this machine" is the product's subject; a single total
    /// mixes it with everything that arrived and answers neither.
    public long BytesSent { get; init; }
    public long BytesReceived { get; init; }

    /// How many completed windows in this period were judged unusual. Zero and
    /// "not enough history to judge" are different states, and the detector
    /// needs a day of measured windows before it will say anything at all.
    public int OutboundAnomalies { get; init; }

    /// Whether the detector has enough measured history to have an opinion at
    /// all. Without this the screen cannot tell "nothing unusual happened"
    /// from "not yet able to say", and a zero would state the first while
    /// meaning the second.
    public bool OutboundBaselineReady { get; init; }

    public IReadOnlyList<SleepPeriod> SleepPeriods { get; init; } = [];
    public double SleepSeconds => SleepPeriods.Sum(period => Math.Max(0, (period.End - period.Start).TotalSeconds));
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
    long HourlySummariesDeleted, long CoverageSessionsDeleted, long ChartSummariesDeleted = 0,
    long SleepPeriodsDeleted = 0)
{
    public long TotalDeleted => ObservationsDeleted + FlowsDeleted + HourlySummariesDeleted + CoverageSessionsDeleted + ChartSummariesDeleted + SleepPeriodsDeleted;
    public bool MayHaveMore(int batchSize) => ObservationsDeleted == batchSize || FlowsDeleted == batchSize ||
        HourlySummariesDeleted == batchSize || CoverageSessionsDeleted == batchSize || ChartSummariesDeleted == batchSize || SleepPeriodsDeleted == batchSize;
}

public sealed record LocalHistoryStatus(int RetentionDays, int RawDays, long StorageBytes,
    DateTimeOffset? OldestRawAt, DateTimeOffset? OldestAggregateAt,
    DateTimeOffset? LastCleanupAt, DateTimeOffset NextCleanupAt);

public sealed record LocalHistoryDeletionResult(long ObservationsDeleted, long FlowsDeleted,
    long HourlySummariesDeleted, long ChartSummariesDeleted, long CoverageSessionsDeleted, long SleepPeriodsDeleted = 0)
{
    public long TotalDeleted => ObservationsDeleted + FlowsDeleted + HourlySummariesDeleted + ChartSummariesDeleted + CoverageSessionsDeleted + SleepPeriodsDeleted;
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
    string? HostnameSourceError = null,
    long EtwConnectionAttempted = 0,
    long EtwConnectionAccepted = 0,
    long EtwConnectionDisconnected = 0,
    long EtwConnectionClosed = 0);

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
