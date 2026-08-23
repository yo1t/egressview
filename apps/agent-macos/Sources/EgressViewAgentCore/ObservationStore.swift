import Foundation
import SQLite3

private let SQLITE_TRANSIENT = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

public enum ObservationStoreError: Error, Equatable {
    case open(String)
    case statement(String)
    case retentionShorterThanRawWindow
}

/// How long history is kept, and how much of it stays as individual
/// observations.
///
/// The two are separate because they answer different questions. The traffic
/// log needs individual sessions; every chart needs "which app, where, how
/// much, when", which survives being folded into hourly totals. Keeping raw
/// rows for the whole retention period would cost gigabytes to answer
/// questions nobody asks of month-old data.
public struct ObservationRetention: Equatable, Sendable {
    public static let allowedRetentionDays = [1, 7, 30, 90]

    public let retentionDays: Int
    public let rawDays: Int

    /// `rawDays` is clamped rather than rejected: a user lowering retention to
    /// 1 day should not have to also remember to lower the raw window, and a
    /// setting that keeps raw rows past the retention period cannot be honoured
    /// anyway.
    public init(retentionDays: Int = 30, rawDays: Int = 14) {
        let retention = ObservationRetention.allowedRetentionDays.contains(retentionDays)
            ? retentionDays
            : 30
        self.retentionDays = retention
        self.rawDays = min(max(1, rawDays), retention)
    }
}

/// Which destination the diagram groups by.
///
/// This is not a display choice. One name spreads across many addresses and one
/// address serves many names, so the two settings produce genuinely different
/// diagrams and answer different questions: what the Mac is talking to, versus
/// how far that traffic is actually spread.
public enum DestinationGrouping: String, Equatable, Sendable, CaseIterable {
    /// The name the application asked for, falling back to the address.
    case name
    case address
}

public struct AppDestinationTotal: Equatable, Sendable {
    public let processName: String
    public let destination: String
    public let sessionCount: Int
    public let bytes: UInt64
    public let observationsWithoutBytes: Int

    public init(
        processName: String,
        destination: String,
        sessionCount: Int,
        bytes: UInt64,
        observationsWithoutBytes: Int
    ) {
        self.processName = processName
        self.destination = destination
        self.sessionCount = sessionCount
        self.bytes = bytes
        self.observationsWithoutBytes = observationsWithoutBytes
    }
}

public struct GeoLocation: Equatable, Sendable {
    public let ip: String
    public let latitude: Double
    public let longitude: Double
    public let countryCode: String?
    public let city: String?

    public init(ip: String, latitude: Double, longitude: Double, countryCode: String?, city: String?) {
        self.ip = ip
        self.latitude = latitude
        self.longitude = longitude
        self.countryCode = countryCode
        self.city = city
    }
}

public struct PlacedDestination: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let countryCode: String?
    public let city: String?
    public let sessionCount: Int
    public let bytes: UInt64
}

public struct AppTimelineTotal: Equatable, Sendable {
    public let bucketIndex: Int
    public let processName: String
    public let sessionCount: Int
    public let bytes: UInt64
    public let observationsWithoutBytes: Int

    public init(
        bucketIndex: Int,
        processName: String,
        sessionCount: Int,
        bytes: UInt64,
        observationsWithoutBytes: Int
    ) {
        self.bucketIndex = bucketIndex
        self.processName = processName
        self.sessionCount = sessionCount
        self.bytes = bytes
        self.observationsWithoutBytes = observationsWithoutBytes
    }
}

public struct ObservationStoreStatistics: Equatable, Sendable {
    public let rawCount: Int
    public let rolledUpCount: Int
    public let oldestObservedAt: Date?
    public let newestObservedAt: Date?
    public let monitoringStartedAt: Date?
    public let fileSizeBytes: Int64
}

/// The durable, period-independent record used to shade countries on the globe.
///
/// One row represents one country, not one destination. This keeps the table
/// bounded by the number of ISO regions even when the Mac runs for years.
public struct CountryVisitSummary: Equatable, Sendable, Identifiable {
    public let countryCode: String
    public let firstObservedAt: Date
    public let lastObservedAt: Date
    public let lastSiteName: String
    public let lastProcessName: String
    public let connectionCount: Int

    public var id: String { countryCode }

    public init(
        countryCode: String,
        firstObservedAt: Date,
        lastObservedAt: Date,
        lastSiteName: String,
        lastProcessName: String,
        connectionCount: Int
    ) {
        self.countryCode = countryCode
        self.firstObservedAt = firstObservedAt
        self.lastObservedAt = lastObservedAt
        self.lastSiteName = lastSiteName
        self.lastProcessName = lastProcessName
        self.connectionCount = connectionCount
    }
}

public enum LegacyObservationImportResult: Equatable, Sendable {
    case imported(Int)
    case alreadyImported(Int)
}

/// One hour of traffic for one app to one destination.
public struct ObservationRollupRow: Equatable, Sendable {
    public let hourStart: Date
    public let processName: String
    public let bundleID: String?
    public let remoteAddress: String
    public let sessionCount: Int
    public let bytesIn: UInt64
    public let bytesOut: UInt64
}

/// Local history for the agent.
///
/// Replaces the JSON Lines journal, which rotated at 10 MiB and kept one
/// archive: about six hours at the observed production rate, while the settings
/// screen offered 1, 7, 30 and 90 days. **The stated retention was not being
/// honoured, and nothing said so.**
public final class ObservationStore: @unchecked Sendable {
    private var handle: OpaquePointer?
    private let lock = NSLock()
    private let fileURL: URL
    public private(set) var retention: ObservationRetention
    private let countrySummaryFlushInterval: TimeInterval
    private var knownVisitedCountries: Set<String> = []
    private var pendingCountryUpdates: [String: CountryVisitAccumulator] = [:]
    private var countryByAddressCache: [String: String] = [:]
    private var unresolvedCountryAddresses: Set<String> = []
    private var lastCountrySummaryFlush = Date()

    private struct CountryVisitAccumulator {
        var firstObservedAt: Date
        var lastObservedAt: Date
        var lastSiteName: String
        var lastProcessName: String
        var connectionCount: Int

        mutating func merge(_ other: CountryVisitAccumulator) {
            firstObservedAt = min(firstObservedAt, other.firstObservedAt)
            connectionCount += other.connectionCount
            if other.lastObservedAt >= lastObservedAt {
                lastObservedAt = other.lastObservedAt
                if !other.lastSiteName.isEmpty { lastSiteName = other.lastSiteName }
                lastProcessName = other.lastProcessName
            }
        }
    }

    public init(
        fileURL: URL,
        retention: ObservationRetention = ObservationRetention(),
        countrySummaryFlushInterval: TimeInterval = 60
    ) throws {
        self.fileURL = fileURL
        self.retention = retention
        self.countrySummaryFlushInterval = max(0, countrySummaryFlushInterval)
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        guard sqlite3_open_v2(
            fileURL.path, &handle,
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil
        ) == SQLITE_OK else {
            throw ObservationStoreError.open(lastMessage)
        }
        // WAL keeps a reader (the UI) from being blocked by the writer (the
        // collector), which run in the same process but different queues.
        try execute("PRAGMA journal_mode=WAL")
        try execute("PRAGMA synchronous=NORMAL")
        try execute("PRAGMA foreign_keys=ON")
        try migrate()
        knownVisitedCountries = try loadVisitedCountryCodes()
        try? FileManager.default.setAttributes(
            [.posixPermissions: 0o600], ofItemAtPath: fileURL.path
        )
    }

    public convenience init(
        fileManager: FileManager = .default,
        retention: ObservationRetention = ObservationRetention()
    ) throws {
        guard let containerURL = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: ObservationJournal.appGroupIdentifier
        ) else {
            throw ObservationStoreError.open("The EgressView App Group container is unavailable")
        }
        try self.init(
            fileURL: containerURL.appendingPathComponent("observations.sqlite"),
            retention: retention
        )
    }

    deinit { sqlite3_close_v2(handle) }

    public func setRetention(_ retention: ObservationRetention) {
        lock.withLock { self.retention = retention }
    }

    // MARK: - Schema

    private func migrate() throws {
        let version = try scalar("PRAGMA user_version") ?? 0
        if version < 1 {
            try execute("""
            CREATE TABLE IF NOT EXISTS observations (
                id INTEGER PRIMARY KEY,
                network_protocol TEXT NOT NULL,
                local_address TEXT NOT NULL,
                local_port INTEGER NOT NULL,
                remote_address TEXT NOT NULL,
                remote_port INTEGER NOT NULL,
                process_id INTEGER NOT NULL,
                process_name TEXT NOT NULL,
                bundle_id TEXT,
                first_observed_at REAL NOT NULL,
                last_observed_at REAL NOT NULL,
                bytes_in INTEGER,
                bytes_out INTEGER,
                collector TEXT NOT NULL,
                confidence TEXT NOT NULL
            )
            """)
            // Every query is "this period", so the time column carries the
            // index. Without it, retention alone would make the UI unusable.
            try execute(
                "CREATE INDEX IF NOT EXISTS observations_last_observed "
                + "ON observations(last_observed_at)"
            )
            try execute("""
            CREATE TABLE IF NOT EXISTS hourly_rollup (
                hour_start REAL NOT NULL,
                process_name TEXT NOT NULL,
                bundle_id TEXT,
                remote_address TEXT NOT NULL,
                session_count INTEGER NOT NULL,
                bytes_in INTEGER NOT NULL,
                bytes_out INTEGER NOT NULL,
                PRIMARY KEY (hour_start, process_name, bundle_id, remote_address)
            )
            """)
            try execute(
                "CREATE INDEX IF NOT EXISTS hourly_rollup_hour ON hourly_rollup(hour_start)"
            )
            try execute("PRAGMA user_version=1")
        }
        if version < 2 {
            try execute("""
            CREATE TABLE IF NOT EXISTS legacy_imports (
                fingerprint TEXT PRIMARY KEY,
                imported_at REAL NOT NULL,
                observation_count INTEGER NOT NULL,
                malformed_line_count INTEGER NOT NULL
            )
            """)
            try execute("PRAGMA user_version=2")
        }
        if version < 3 {
            // Local only. The name the application asked for is not part of the
            // ingest contract, so it lives here and nowhere else.
            try execute("ALTER TABLE observations ADD COLUMN remote_hostname TEXT")
            try execute("PRAGMA user_version=3")
        }
        if version < 4 {
            // Locations for destinations. Received in bulk from the Hub, or
            // absent entirely when the agent runs on its own -- in which case
            // the map says so rather than showing an empty world.
            try execute("""
            CREATE TABLE IF NOT EXISTS geo_locations (
                ip TEXT PRIMARY KEY,
                latitude REAL NOT NULL,
                longitude REAL NOT NULL,
                country_code TEXT,
                city TEXT,
                received_at REAL NOT NULL
            )
            """)
            try execute("PRAGMA user_version=4")
        }
        if version < 5 {
            // When monitoring was actually running. Without this, a period with
            // no connections and a period that was never watched look
            // identical, and every chart quietly presents the second as the
            // first. `ended_at` is null while a session is open.
            try execute("""
            CREATE TABLE IF NOT EXISTS coverage_sessions (
                id INTEGER PRIMARY KEY,
                started_at REAL NOT NULL,
                ended_at REAL
            )
            """)
            try execute(
                "CREATE INDEX IF NOT EXISTS coverage_sessions_started ON coverage_sessions(started_at)"
            )
            // History collected before this table existed has no record of when
            // monitoring was running, so it is credited with one session
            // spanning what was observed. That is an inference, and it can
            // cover a real outage inside the span -- but the alternative is
            // telling the user that months of data they watched arrive were
            // never monitored, which is both false and more alarming. Periods
            // after this upgrade are measured rather than inferred.
            try execute("""
            INSERT INTO coverage_sessions (started_at, ended_at)
            SELECT min(first_observed_at), max(last_observed_at) FROM observations
            HAVING count(*) > 0
            """)
            try execute("PRAGMA user_version=5")
        }
        if version < 6 {
            // When the Mac was asleep. A sleep and a monitoring failure both
            // leave a hole in the record, and they mean opposite things: one is
            // the machine not running, the other is this agent not working.
            // Without this they are indistinguishable, and a sleep gets read as
            // a fault -- which is exactly what happened on 2026-08-15.
            try execute("""
            CREATE TABLE IF NOT EXISTS sleep_periods (
                id INTEGER PRIMARY KEY,
                started_at REAL NOT NULL,
                ended_at REAL
            )
            """)
            try execute(
                "CREATE INDEX IF NOT EXISTS sleep_periods_started ON sleep_periods(started_at)"
            )
            try execute("PRAGMA user_version=6")
        }
        if version < 7 {
            // Threat indicators, received whole and matched locally. Kept here
            // rather than in memory so a restart does not leave the screen
            // unable to say anything until the next fetch.
            try execute("""
            CREATE TABLE IF NOT EXISTS threat_indicators (
                kind TEXT NOT NULL,
                value TEXT NOT NULL,
                source TEXT,
                tag TEXT,
                PRIMARY KEY (kind, value)
            )
            """)
            try execute("PRAGMA user_version=7")
        }
        if version < 8 {
            // Hourly totals for the charts.
            //
            // Distinct from `hourly_rollup`, which exists to keep *old* history
            // small and is only written when data ages out. This one covers
            // every hour, including the most recent, so a chart never has to
            // aggregate hundreds of thousands of raw rows: measured on this
            // machine, a thirty-day diagram went from 473 ms to 31 ms, over
            // 35,396 rows instead of 756,429.
            //
            // It keeps the hostname, which `hourly_rollup` drops. Without it,
            // "destinations by name" would stop working for anything but the
            // last few minutes.
            try execute("""
            CREATE TABLE IF NOT EXISTS chart_hourly (
                hour_start REAL NOT NULL,
                process_name TEXT NOT NULL,
                remote_address TEXT NOT NULL,
                remote_hostname TEXT NOT NULL DEFAULT '',
                session_count INTEGER NOT NULL,
                bytes INTEGER NOT NULL,
                unknown_bytes INTEGER NOT NULL,
                PRIMARY KEY (hour_start, process_name, remote_address, remote_hostname)
            )
            """)
            try execute("CREATE INDEX IF NOT EXISTS chart_hourly_hour ON chart_hourly(hour_start)")
            // How far the fold has got. Hours at or after this are still only
            // in `observations`; hours before it are in both until retention
            // deletes the raw rows.
            try execute("""
            CREATE TABLE IF NOT EXISTS chart_hourly_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                folded_through REAL NOT NULL
            )
            """)
            try execute("PRAGMA user_version=8")
        }
        if version < 9 {
            // A bounded, period-independent memory of countries reached. The
            // normal observation tables obey retention and cannot answer
            // "have I ever connected there?" after their rows age out.
            try execute("""
            CREATE TABLE IF NOT EXISTS country_visit_summary (
                country_code TEXT PRIMARY KEY,
                first_observed_at REAL NOT NULL,
                last_observed_at REAL NOT NULL,
                last_site_name TEXT NOT NULL DEFAULT '',
                last_process_name TEXT NOT NULL,
                connection_count INTEGER NOT NULL
            )
            """)
            try execute("""
            CREATE TABLE IF NOT EXISTS pending_destination_country (
                remote_address TEXT PRIMARY KEY,
                last_site_name TEXT NOT NULL DEFAULT '',
                last_process_name TEXT NOT NULL,
                first_observed_at REAL NOT NULL,
                last_observed_at REAL NOT NULL,
                connection_count INTEGER NOT NULL
            )
            """)
            try execute(
                "CREATE INDEX IF NOT EXISTS pending_destination_country_last "
                + "ON pending_destination_country(last_observed_at)"
            )
            try execute("""
            CREATE TABLE IF NOT EXISTS country_visit_state (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                retained_history_backfilled_at REAL
            )
            """)
            try execute("PRAGMA user_version=9")
        }
        if version < 10 {
            // Network Extension reports the same flow when it opens and when
            // it closes. The second report may add SNI and byte counts; it is
            // an update, not another connection. Existing history has no
            // trustworthy flow identity and remains nullable rather than being
            // guessed from an address that may be shared by many hostnames.
            try execute("ALTER TABLE observations ADD COLUMN flow_id TEXT")
            try execute(
                "CREATE UNIQUE INDEX IF NOT EXISTS observations_flow_id "
                + "ON observations(flow_id) WHERE flow_id IS NOT NULL"
            )
            try execute("PRAGMA user_version=10")
        }
    }

    // MARK: - Coverage

    /// Records that monitoring started. Any session left open by a previous run
    /// is closed first, at the last moment we know data was arriving -- an
    /// abrupt end is still an end, and leaving it open would claim coverage for
    /// a period that has none.
    public func beginCoverageSession(at date: Date) throws {
        try closeOpenCoverageSessions(fallbackEnd: date)
        try execute(
            "INSERT INTO coverage_sessions (started_at, ended_at) VALUES (\(date.timeIntervalSince1970), NULL)"
        )
    }

    public func endCoverageSession(at date: Date) throws {
        try execute("""
        UPDATE coverage_sessions SET ended_at = \(date.timeIntervalSince1970)
        WHERE ended_at IS NULL
        """)
    }

    private func closeOpenCoverageSessions(fallbackEnd: Date) throws {
        // The last observation is the last proof of coverage. Falling back to
        // the session's own start means a crashed run claims nothing.
        try execute("""
        UPDATE coverage_sessions
        SET ended_at = max(
            started_at,
            coalesce((SELECT max(last_observed_at) FROM observations), started_at)
        )
        WHERE ended_at IS NULL
        """)
    }

    /// Country codes for the addresses given, for the ones that are known.
    ///
    /// Looked up for the rows on screen rather than by loading the whole cache:
    /// it holds tens of thousands of entries and the log shows at most a few
    /// hundred addresses.
    public func countryCodes(forAddresses addresses: [String]) throws -> [String: String] {
        let unique = Array(Set(addresses))
        guard !unique.isEmpty else { return [:] }
        var result: [String: String] = [:]
        // Chunked: SQLite has a limit on how many values a statement may bind.
        for chunk in stride(from: 0, to: unique.count, by: 400).map({
            Array(unique[$0..<min($0 + 400, unique.count)])
        }) {
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ",")
            let statement = try prepare("""
            SELECT ip, country_code FROM geo_locations
            WHERE country_code IS NOT NULL AND ip IN (\(placeholders))
            """)
            defer { sqlite3_finalize(statement) }
            for (index, address) in chunk.enumerated() {
                bindText(statement, Int32(index + 1), address)
            }
            while sqlite3_step(statement) == SQLITE_ROW {
                guard let ip = text(statement, 0), let code = text(statement, 1) else { continue }
                result[ip] = code
            }
        }
        return result
    }

    /// Records that the Mac went to sleep. Any period left open is closed
    /// first: a sleep that was never woken from is a sleep that ended when the
    /// machine came back, and leaving it open would swallow everything since.
    public func beginSleepPeriod(at date: Date) throws {
        try execute("""
        UPDATE sleep_periods SET ended_at = \(date.timeIntervalSince1970)
        WHERE ended_at IS NULL
        """)
        try execute(
            "INSERT INTO sleep_periods (started_at, ended_at) VALUES (\(date.timeIntervalSince1970), NULL)"
        )
    }

    public func endSleepPeriod(at date: Date) throws {
        try execute("""
        UPDATE sleep_periods SET ended_at = \(date.timeIntervalSince1970)
        WHERE ended_at IS NULL
        """)
    }

    public func sleepPeriods(from: Date, to: Date) throws -> [DateInterval] {
        let statement = try prepare("""
        SELECT started_at, coalesce(ended_at, \(to.timeIntervalSince1970)) FROM sleep_periods
        WHERE started_at <= \(to.timeIntervalSince1970)
          AND coalesce(ended_at, \(Date.distantFuture.timeIntervalSince1970)) >= \(from.timeIntervalSince1970)
        ORDER BY started_at
        """)
        defer { sqlite3_finalize(statement) }
        var result: [DateInterval] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let start = max(from, Date(timeIntervalSince1970: sqlite3_column_double(statement, 0)))
            let end = min(to, Date(timeIntervalSince1970: sqlite3_column_double(statement, 1)))
            if end > start { result.append(DateInterval(start: start, end: end)) }
        }
        return result
    }

    // MARK: - Threat indicators

    /// Replaces the whole indicator set in one transaction.
    ///
    /// Whole, not merged: a feed dropping an entry means it is no longer
    /// considered dangerous, and merging would keep condemning it forever.
    public func replaceThreatIndicators(_ indicators: [ThreatIndicator]) throws {
        try execute("BEGIN IMMEDIATE")
        do {
            try execute("DELETE FROM threat_indicators")
            let statement = try prepare("""
            INSERT OR REPLACE INTO threat_indicators (kind, value, source, tag)
            VALUES (?, ?, ?, ?)
            """)
            defer { sqlite3_finalize(statement) }
            for indicator in indicators {
                sqlite3_reset(statement)
                bindText(statement, 1, indicator.kind.rawValue)
                bindText(statement, 2, indicator.value)
                bindOptionalText(statement, 3, indicator.source)
                bindOptionalText(statement, 4, indicator.tag)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw ObservationStoreError.statement(lastMessage)
                }
            }
            try execute("COMMIT")
        } catch {
            try? execute("ROLLBACK")
            throw error
        }
    }

    public func threatIndicators() throws -> [ThreatIndicator] {
        let statement = try prepare("SELECT kind, value, source, tag FROM threat_indicators")
        defer { sqlite3_finalize(statement) }
        var result: [ThreatIndicator] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let kindText = text(statement, 0),
                  let kind = ThreatIndicator.Kind(rawValue: kindText),
                  let value = text(statement, 1)
            else { continue }
            result.append(ThreatIndicator(
                kind: kind, value: value, source: text(statement, 2), tag: text(statement, 3)
            ))
        }
        return result
    }

    public func threatIndicatorCount() throws -> Int {
        try scalar("SELECT count(*) FROM threat_indicators") ?? 0
    }

    /// How much is stored and over what span -- counts and dates only.
    ///
    /// Deliberately returns no address, process name or hostname. This is what
    /// the diagnostics export reads, and the export must not be able to carry
    /// the user's traffic out of the machine even by accident. Keeping the
    /// return type incapable of holding one is stronger than remembering not
    /// to put one in.
    public func storageSummary() throws -> ObservationStorageSummary {
        let rawCount = try scalar("SELECT count(*) FROM observations") ?? 0
        let rolledUpCount = try scalar("SELECT count(*) FROM hourly_rollup") ?? 0
        let chartCount = try scalar("SELECT count(*) FROM chart_hourly") ?? 0
        let oldest = try scalarDouble("SELECT min(first_observed_at) FROM observations")
            .map { Date(timeIntervalSince1970: $0) }
        let newest = try scalarDouble("SELECT max(last_observed_at) FROM observations")
            .map { Date(timeIntervalSince1970: $0) }
        return ObservationStorageSummary(
            rawObservationCount: rawCount,
            rolledUpHourCount: rolledUpCount,
            chartHourCount: chartCount,
            threatIndicatorCount: try threatIndicatorCount(),
            oldestObservationAt: oldest,
            newestObservationAt: newest
        )
    }

    /// Distinct destinations in the period, for matching against the
    /// indicators. Matching happens in Swift rather than in SQL because the
    /// parent-domain and CIDR rules are not expressible as a join, and having
    /// two implementations of the rules is exactly what is being avoided.
    public func destinationsForThreatMatching(
        from: Date, to: Date
    ) throws -> [ThreatCandidate] {
        let statement = try prepare("""
        SELECT remote_address, remote_hostname, process_name,
               count(*), max(last_observed_at), min(first_observed_at),
               sum(coalesce(bytes_in, 0) + coalesce(bytes_out, 0)),
               sum(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END)
        FROM observations
        WHERE last_observed_at >= \(from.timeIntervalSince1970)
          AND last_observed_at <= \(to.timeIntervalSince1970)
        GROUP BY remote_address, remote_hostname, process_name
        """)
        defer { sqlite3_finalize(statement) }
        var result: [ThreatCandidate] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let address = text(statement, 0) else { continue }
            result.append(ThreatCandidate(
                address: address,
                hostname: text(statement, 1),
                processName: text(statement, 2) ?? "",
                sessionCount: Int(sqlite3_column_int64(statement, 3)),
                lastObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 4)),
                firstObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 5)),
                bytes: UInt64(max(0, sqlite3_column_int64(statement, 6))),
                observationsWithoutBytes: Int(sqlite3_column_int64(statement, 7))
            ))
        }
        return result
    }

    public func coverageSessions(from: Date, to: Date) throws -> [CoverageSession] {
        let statement = try prepare("""
        SELECT started_at, ended_at FROM coverage_sessions
        WHERE started_at <= \(to.timeIntervalSince1970)
          AND coalesce(ended_at, \(Date.distantFuture.timeIntervalSince1970)) >= \(from.timeIntervalSince1970)
        ORDER BY started_at
        """)
        defer { sqlite3_finalize(statement) }
        var result: [CoverageSession] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            let end = sqlite3_column_type(statement, 1) == SQLITE_NULL
                ? nil : sqlite3_column_double(statement, 1)
            result.append(CoverageSession(
                start: Date(timeIntervalSince1970: sqlite3_column_double(statement, 0)),
                end: end.map(Date.init(timeIntervalSince1970:))
            ))
        }
        return result
    }

    /// The first time this database has proof that monitoring was active.
    /// Unlike a selected period's coverage, this does not move when the user
    /// changes the chart range or when observation retention removes old rows.
    public func monitoringStartedAt() throws -> Date? {
        try lock.withLock { try monitoringStartedAtLocked() }
    }

    private func monitoringStartedAtLocked() throws -> Date? {
        try scalarDouble("SELECT MIN(started_at) FROM coverage_sessions")
            .map { Date(timeIntervalSince1970: $0) }
    }

    // MARK: - Writing

    public func append(_ observations: [ConnectionObservation]) throws {
        guard !observations.isEmpty else { return }
        try lock.withLock {
            let countriesBefore = knownVisitedCountries
            let updatesBefore = pendingCountryUpdates
            let flushBefore = lastCountrySummaryFlush
            try execute("BEGIN IMMEDIATE")
            do {
                let countryVisitInputs = try newFlowObservationsForCountryHistory(observations)
                try insert(observations)
                try recordCountryVisitsLocked(countryVisitInputs, now: Date())
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                knownVisitedCountries = countriesBefore
                pendingCountryUpdates = updatesBefore
                lastCountrySummaryFlush = flushBefore
                throw error
            }
        }
    }

    /// Imports one immutable snapshot of the legacy journal exactly once.
    /// The marker and rows commit together, so a crash cannot leave a marker
    /// without data or duplicate the data on the next launch.
    public func importLegacyJournal(
        _ batch: LegacyObservationBatch,
        importedAt: Date = Date()
    ) throws -> LegacyObservationImportResult {
        try lock.withLock {
            try execute("BEGIN IMMEDIATE")
            do {
                if let count = try importedLegacyCount(fingerprint: batch.fingerprint) {
                    try execute("COMMIT")
                    return .alreadyImported(count)
                }
                try insert(batch.observations)
                let statement = try prepare("""
                INSERT INTO legacy_imports (
                    fingerprint, imported_at, observation_count, malformed_line_count
                ) VALUES (?, ?, ?, ?)
                """)
                defer { sqlite3_finalize(statement) }
                bindText(statement, 1, batch.fingerprint)
                sqlite3_bind_double(statement, 2, importedAt.timeIntervalSince1970)
                sqlite3_bind_int64(statement, 3, Int64(batch.observations.count))
                sqlite3_bind_int64(statement, 4, Int64(batch.malformedLineCount))
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw ObservationStoreError.statement(lastMessage)
                }
                try execute("COMMIT")
                return .imported(batch.observations.count)
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    // MARK: - Reading

    /// Individual sessions, newest first. Only the traffic-log table needs
    /// these, and only within the raw window.
    public func observations(since: Date? = nil, limit: Int = 500) throws -> [ConnectionObservation] {
        try lock.withLock {
            var sql = "SELECT * FROM observations"
            if since != nil { sql += " WHERE last_observed_at >= ?" }
            sql += " ORDER BY last_observed_at DESC LIMIT ?"
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            var index: Int32 = 1
            if let since {
                sqlite3_bind_double(statement, index, since.timeIntervalSince1970)
                index += 1
            }
            sqlite3_bind_int64(statement, index, Int64(max(0, limit)))

            var rows: [ConnectionObservation] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(decodeObservation(statement))
            }
            return rows
        }
    }

    /// Hourly totals across both storage shapes, so a chart spanning the
    /// boundary between raw and folded data does not show a cliff where the
    /// fold happened.
    public func hourlyRollup(from: Date, to: Date) throws -> [ObservationRollupRow] {
        try lock.withLock {
            let sql = """
            SELECT hour_start, process_name, bundle_id, remote_address,
                   SUM(session_count), SUM(bytes_in), SUM(bytes_out)
            FROM (
                SELECT hour_start, process_name, bundle_id, remote_address,
                       session_count, bytes_in, bytes_out
                FROM hourly_rollup
                WHERE hour_start >= ?1 AND hour_start < ?2
                UNION ALL
                SELECT CAST(last_observed_at / 3600 AS INTEGER) * 3600.0,
                       process_name, bundle_id, remote_address,
                       1, COALESCE(bytes_in, 0), COALESCE(bytes_out, 0)
                FROM observations
                WHERE last_observed_at >= ?1 AND last_observed_at < ?2
            )
            GROUP BY hour_start, process_name, bundle_id, remote_address
            ORDER BY hour_start
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)

            var rows: [ObservationRollupRow] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(ObservationRollupRow(
                    hourStart: Date(timeIntervalSince1970: sqlite3_column_double(statement, 0)),
                    processName: text(statement, 1) ?? "",
                    bundleID: text(statement, 2),
                    remoteAddress: text(statement, 3) ?? "",
                    sessionCount: Int(sqlite3_column_int64(statement, 4)),
                    bytesIn: UInt64(max(0, sqlite3_column_int64(statement, 5))),
                    bytesOut: UInt64(max(0, sqlite3_column_int64(statement, 6)))
                ))
            }
            return rows
        }
    }

    /// One application talking to one destination over the selected period.
    ///
    /// `bytes` is the total of the flows whose counts are known.
    /// `observationsWithoutBytes` is reported alongside rather than folded in
    /// as zero: with byte counts arriving only when a flow closes, treating an
    /// unknown as zero would draw silence where nothing was measured.
    public func appDestinationTotals(
        from: Date,
        to: Date,
        grouping: DestinationGrouping = .name
    ) throws -> [AppDestinationTotal] {
        try lock.withLock {
            let destinationExpression = grouping == .name
                ? "COALESCE(NULLIF(remote_hostname, ''), remote_address)"
                : "remote_address"
            // Three sources, and each covers a stretch the others do not.
            //
            // `chart_hourly` holds every complete hour and is what makes this
            // fast: 31 ms instead of 473 ms over thirty days on this machine,
            // because it is a twentieth of the rows. `observations` covers only
            // the hour still in progress, past the fold watermark. And
            // `hourly_rollup` covers history so old that the raw rows have been
            // deleted -- kept for databases folded by an older version, where
            // `chart_hourly` was never written for those hours.
            let watermark = (try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0)
            let ranges = chartRanges(from: from, to: to, watermark: watermark)
            let sql = """
            SELECT process_name, destination,
                   SUM(sessions) AS sessions,
                   SUM(total_bytes) AS total_bytes,
                   SUM(unknown) AS unknown
            FROM (
                SELECT process_name,
                       \(grouping == .name
                         ? "COALESCE(NULLIF(remote_hostname, ''), remote_address)"
                         : "remote_address") AS destination,
                       SUM(session_count) AS sessions,
                       SUM(bytes) AS total_bytes,
                       SUM(unknown_bytes) AS unknown
                FROM chart_hourly
                WHERE hour_start >= ?3 AND hour_start < ?4
                GROUP BY process_name, destination
                UNION ALL
                SELECT process_name,
                       \(destinationExpression) AS destination,
                       COUNT(*) AS sessions,
                       COALESCE(SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)), 0) AS total_bytes,
                       SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END) AS unknown
                FROM observations
                WHERE last_observed_at >= ?1 AND last_observed_at < ?2
                  AND (last_observed_at < ?3 OR last_observed_at >= ?4)
                GROUP BY process_name, destination
                UNION ALL
                SELECT process_name,
                       remote_address AS destination,
                       SUM(session_count) AS sessions,
                       SUM(bytes_in + bytes_out) AS total_bytes,
                       0 AS unknown
                FROM hourly_rollup
                WHERE hour_start >= ?1 AND hour_start < ?2
                  AND hour_start NOT IN (SELECT hour_start FROM chart_hourly)
                GROUP BY process_name, destination
            )
            GROUP BY process_name, destination
            ORDER BY sessions DESC
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)
            sqlite3_bind_double(statement, 3, ranges.aggregateStart)
            sqlite3_bind_double(statement, 4, ranges.aggregateEnd)

            var rows: [AppDestinationTotal] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(AppDestinationTotal(
                    processName: text(statement, 0) ?? "",
                    destination: text(statement, 1) ?? "",
                    sessionCount: Int(sqlite3_column_int64(statement, 2)),
                    bytes: UInt64(max(0, sqlite3_column_int64(statement, 3))),
                    observationsWithoutBytes: Int(sqlite3_column_int64(statement, 4))
                ))
            }
            return rows
        }
    }

    /// Per-application totals placed into a fixed number of equal buckets.
    ///
    /// The bucket count is fixed and the width follows the period, so drawing
    /// thirty days costs no more than drawing one hour.
    // MARK: - Chart aggregate

    /// Folds every complete hour that has not been folded yet.
    ///
    /// Only *complete* hours: the hour in progress keeps arriving, and folding
    /// it would either be wrong or have to be redone. Charts read the aggregate
    /// up to the watermark and the raw rows after it, so nothing is counted
    /// twice and nothing is missing.
    ///
    /// Cheap enough to run on a timer while collection continues: 20 ms for an
    /// hour of 11,740 observations on this machine.
    @discardableResult
    public func foldCompletedHoursForCharts(now: Date = Date()) throws -> Int {
        try lock.withLock {
            let currentHour = (now.timeIntervalSince1970 / 3600).rounded(.down) * 3600
            let watermark = try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0
            guard currentHour > watermark else { return 0 }

            try execute("BEGIN IMMEDIATE")
            do {
                try execute("""
                INSERT INTO chart_hourly (
                    hour_start, process_name, remote_address, remote_hostname,
                    session_count, bytes, unknown_bytes
                )
                SELECT CAST(last_observed_at / 3600 AS INTEGER) * 3600.0,
                       process_name, remote_address,
                       COALESCE(NULLIF(remote_hostname, ''), ''),
                       COUNT(*),
                       SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)),
                       SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END)
                FROM observations
                WHERE last_observed_at >= \(watermark) AND last_observed_at < \(currentHour)
                GROUP BY 1, process_name, remote_address, 4
                ON CONFLICT(hour_start, process_name, remote_address, remote_hostname) DO UPDATE SET
                    session_count = session_count + excluded.session_count,
                    bytes = bytes + excluded.bytes,
                    unknown_bytes = unknown_bytes + excluded.unknown_bytes
                """)
                try execute("""
                INSERT INTO chart_hourly_state (id, folded_through) VALUES (1, \(currentHour))
                ON CONFLICT(id) DO UPDATE SET folded_through = excluded.folded_through
                """)
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
            return try scalar(
                "SELECT COUNT(*) FROM chart_hourly WHERE hour_start >= \(watermark)"
            ) ?? 0
        }
    }

    /// Which stretch each source may answer for, so no hour is counted twice
    /// and no minute is dropped.
    ///
    /// The aggregate is hourly and the period is not: "the last 24 hours" ends
    /// wherever now happens to be. Reading `hour_start >= from` silently drops
    /// the part-hour at the start and swallows the whole hour at the end -- an
    /// error of up to an hour at each edge, which is nothing across a month and
    /// everything across an hour.
    ///
    /// So the aggregate answers only for **whole hours inside the period that
    /// have been folded**, and the raw rows answer for the ragged ends and for
    /// everything since the fold.
    struct ChartRanges {
        /// Whole folded hours: `[aggregateStart, aggregateEnd)`, empty when
        /// `aggregateEnd <= aggregateStart`.
        let aggregateStart: Double
        let aggregateEnd: Double

        var hasAggregate: Bool { aggregateEnd > aggregateStart }
    }

    func chartRanges(from: Date, to: Date, watermark: Double) -> ChartRanges {
        let fromSeconds = from.timeIntervalSince1970
        let toSeconds = to.timeIntervalSince1970
        let start = (fromSeconds / 3600).rounded(.up) * 3600
        let end = min((toSeconds / 3600).rounded(.down) * 3600, watermark)
        return ChartRanges(aggregateStart: start, aggregateEnd: max(start, end))
    }

    /// The boundary between the aggregate and the raw rows.
    public func chartFoldWatermark() throws -> Date {
        let seconds = try lock.withLock {
            try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0
        }
        return Date(timeIntervalSince1970: seconds)
    }

    /// Writes an hourly total directly, for tests that need history older than
    /// the raw window without waiting `rawDays` for it.
    ///
    /// Exposed rather than reached around, so the tests exercise the same table
    /// the retention job writes.
    public func insertRolledUpHourForTesting(
        hourStart: Date, processName: String, bundleID: String? = nil,
        remoteAddress: String, sessionCount: Int, bytesIn: Int, bytesOut: Int
    ) throws {
        try lock.withLock {
            let statement = try prepare("""
            INSERT OR REPLACE INTO hourly_rollup
                (hour_start, process_name, bundle_id, remote_address,
                 session_count, bytes_in, bytes_out)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, hourStart.timeIntervalSince1970)
            bindText(statement, 2, processName)
            bindOptionalText(statement, 3, bundleID)
            bindText(statement, 4, remoteAddress)
            sqlite3_bind_int64(statement, 5, Int64(sessionCount))
            sqlite3_bind_int64(statement, 6, Int64(bytesIn))
            sqlite3_bind_int64(statement, 7, Int64(bytesOut))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw ObservationStoreError.statement(lastMessage)
            }
        }
    }

    /// The moment before which individual observations no longer exist: older
    /// history survives only as hourly totals.
    public func rawHistoryCutoff(now: Date = Date()) -> Date {
        now.addingTimeInterval(-Double(retention.rawDays) * 86_400)
    }

    /// True when the period reaches back into hours that were folded up, so the
    /// screen can say what changes about them: no hostnames, no byte-coverage
    /// counts, and no resolution finer than an hour.
    public func periodUsesRolledUpHistory(from: Date, to: Date, now: Date = Date()) throws -> Bool {
        guard from < rawHistoryCutoff(now: now) else { return false }
        return try lock.withLock {
            let statement = try prepare("""
            SELECT 1 FROM hourly_rollup
            WHERE hour_start >= \(from.timeIntervalSince1970)
              AND hour_start < \(to.timeIntervalSince1970)
            LIMIT 1
            """)
            defer { sqlite3_finalize(statement) }
            return sqlite3_step(statement) == SQLITE_ROW
        }
    }

    public func appTimeline(from: Date, to: Date, buckets: Int) throws -> [AppTimelineTotal] {
        let bucketCount = max(1, min(240, buckets))
        let span = to.timeIntervalSince(from)
        guard span > 0 else { return [] }
        let width = span / Double(bucketCount)

        return try lock.withLock {
            // Hourly rows land in the bucket their hour starts in. Every
            // period that reaches back past the fold watermark has buckets an
            // hour or wider, so nothing is smeared across a bucket it did not
            // belong to.
            // The aggregate is hourly, so it can only be read into buckets an
            // hour or wider. Reading it into six-minute buckets put a whole
            // hour into one of them and left the other nine empty -- a chart of
            // spikes and gaps that looked like the Mac had stopped talking.
            // Below that width the raw rows answer for the whole period, which
            // they can: anything finer than an hour is well inside the window
            // where individual observations are still kept.
            let watermark = width >= 3600
                ? (try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0)
                : 0
            let ranges = chartRanges(from: from, to: to, watermark: watermark)
            let sql = """
            SELECT bucket, process_name,
                   SUM(sessions) AS sessions,
                   SUM(total_bytes) AS total_bytes,
                   SUM(unknown) AS unknown
            FROM (
                SELECT MIN(CAST((hour_start - ?1) / ?3 AS INTEGER), ?4) AS bucket,
                       process_name,
                       SUM(session_count) AS sessions,
                       SUM(bytes) AS total_bytes,
                       SUM(unknown_bytes) AS unknown
                FROM chart_hourly
                WHERE hour_start >= ?6 AND hour_start < ?7
                GROUP BY bucket, process_name
                UNION ALL
                SELECT MIN(CAST((last_observed_at - ?1) / ?3 AS INTEGER), ?4) AS bucket,
                       process_name,
                       COUNT(*) AS sessions,
                       COALESCE(SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)), 0) AS total_bytes,
                       SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END) AS unknown
                FROM observations
                WHERE last_observed_at >= ?1 AND last_observed_at < ?2
                  AND (last_observed_at < ?6 OR last_observed_at >= ?7)
                GROUP BY bucket, process_name
                UNION ALL
                SELECT MIN(CAST((hour_start - ?1) / ?3 AS INTEGER), ?4) AS bucket,
                       process_name,
                       SUM(session_count) AS sessions,
                       SUM(bytes_in + bytes_out) AS total_bytes,
                       0 AS unknown
                FROM hourly_rollup
                WHERE hour_start >= ?1 AND hour_start < ?2
                  AND hour_start NOT IN (SELECT hour_start FROM chart_hourly)
                GROUP BY bucket, process_name
            )
            GROUP BY bucket, process_name
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)
            sqlite3_bind_double(statement, 3, width)
            sqlite3_bind_int64(statement, 4, Int64(bucketCount - 1))
            sqlite3_bind_double(statement, 6, ranges.aggregateStart)
            sqlite3_bind_double(statement, 7, ranges.aggregateEnd)

            var rows: [AppTimelineTotal] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                rows.append(AppTimelineTotal(
                    bucketIndex: Int(sqlite3_column_int64(statement, 0)),
                    processName: text(statement, 1) ?? "",
                    sessionCount: Int(sqlite3_column_int64(statement, 2)),
                    bytes: UInt64(max(0, sqlite3_column_int64(statement, 3))),
                    observationsWithoutBytes: Int(sqlite3_column_int64(statement, 4))
                ))
            }
            return rows
        }
    }

    /// Replaces the stored locations with what the Hub supplied.
    public func replaceGeoLocations(_ entries: [GeoLocation], receivedAt: Date = Date()) throws {
        try lock.withLock {
            let countriesBefore = knownVisitedCountries
            let updatesBefore = pendingCountryUpdates
            try execute("BEGIN IMMEDIATE")
            do {
                try execute("DELETE FROM geo_locations")
                let statement = try prepare("""
                INSERT OR REPLACE INTO geo_locations
                    (ip, latitude, longitude, country_code, city, received_at)
                VALUES (?,?,?,?,?,?)
                """)
                defer { sqlite3_finalize(statement) }
                for entry in entries {
                    sqlite3_reset(statement)
                    bindText(statement, 1, entry.ip)
                    sqlite3_bind_double(statement, 2, entry.latitude)
                    sqlite3_bind_double(statement, 3, entry.longitude)
                    bindOptionalText(statement, 4, entry.countryCode)
                    bindOptionalText(statement, 5, entry.city)
                    sqlite3_bind_double(statement, 6, receivedAt.timeIntervalSince1970)
                    guard sqlite3_step(statement) == SQLITE_DONE else {
                        throw ObservationStoreError.statement(lastMessage)
                    }
                }
                countryByAddressCache.removeAll(keepingCapacity: true)
                unresolvedCountryAddresses.removeAll(keepingCapacity: true)
                if try backfillCountryVisitsLocked(now: receivedAt) {
                    // Every retained observation was included in the one-time
                    // backfill, so resolving these rows again would double its
                    // connection count.
                    try execute("""
                    DELETE FROM pending_destination_country
                    WHERE EXISTS (
                        SELECT 1 FROM geo_locations g
                        WHERE g.ip = pending_destination_country.remote_address
                          AND g.country_code IS NOT NULL
                    )
                    """)
                } else {
                    try resolvePendingCountriesLocked()
                }
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                knownVisitedCountries = countriesBefore
                pendingCountryUpdates = updatesBefore
                throw error
            }
        }
    }

    public func geoLocationCount() throws -> Int {
        try lock.withLock { try scalar("SELECT COUNT(*) FROM geo_locations") ?? 0 }
    }

    /// All countries ever observed, independent of the normal retention window.
    public func countryVisitSummaries() throws -> [CountryVisitSummary] {
        try lock.withLock {
            let statement = try prepare("""
            SELECT country_code, first_observed_at, last_observed_at,
                   last_site_name, last_process_name, connection_count
            FROM country_visit_summary
            ORDER BY connection_count DESC, last_observed_at DESC
            """)
            defer { sqlite3_finalize(statement) }
            var rows: [CountryVisitSummary] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                guard let code = text(statement, 0) else { continue }
                rows.append(CountryVisitSummary(
                    countryCode: code,
                    firstObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 1)),
                    lastObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 2)),
                    lastSiteName: text(statement, 3) ?? "",
                    lastProcessName: text(statement, 4) ?? "",
                    connectionCount: Int(sqlite3_column_int64(statement, 5))
                ))
            }
            return rows
        }
    }

    /// Persists the at-most-one-minute aggregate before a clean shutdown.
    public func flushCountryVisitSummary() throws {
        try lock.withLock {
            guard !pendingCountryUpdates.isEmpty else { return }
            let updatesBefore = pendingCountryUpdates
            let flushBefore = lastCountrySummaryFlush
            try execute("BEGIN IMMEDIATE")
            do {
                try flushCountryUpdatesLocked()
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                pendingCountryUpdates = updatesBefore
                lastCountrySummaryFlush = flushBefore
                throw error
            }
        }
    }

    /// Seeds the all-time country memory from retained chart history once.
    ///
    /// Completed hours come from `chart_hourly`; only the not-yet-folded tail
    /// is read from raw observations. This avoids scanning the same 14 days of
    /// raw rows twice on an established database.
    @discardableResult
    public func backfillCountryVisitsFromRetainedHistory() throws -> Bool {
        try lock.withLock {
            guard try scalar("SELECT COUNT(*) FROM geo_locations") ?? 0 > 0 else { return false }
            let countriesBefore = knownVisitedCountries
            try execute("BEGIN IMMEDIATE")
            do {
                let performed = try backfillCountryVisitsLocked(now: Date())
                try execute("COMMIT")
                return performed
            } catch {
                try? execute("ROLLBACK")
                knownVisitedCountries = countriesBefore
                throw error
            }
        }
    }

    /// Traffic per placeable destination for the selected period.
    ///
    /// Destinations with no known location are counted separately rather than
    /// dropped: a map that quietly omits half the traffic is worse than one
    /// that says how much it cannot place.
    public func destinationLocations(
        from: Date,
        to: Date
    ) throws -> (placed: [PlacedDestination], unplacedSessions: Int, unplacedBytes: UInt64) {
        try lock.withLock {
            let watermark = (try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0)
            let ranges = chartRanges(from: from, to: to, watermark: watermark)
            // Rolled-up hours keep the address, so they can still be placed
            // on the map. Without this half, a month on the globe showed only
            // the days still held as individual observations.
            let sql = """
            SELECT latitude, longitude, country_code, city,
                   SUM(sessions) AS sessions, SUM(total) AS total
            FROM (
                SELECT g.latitude, g.longitude, g.country_code, g.city,
                       SUM(c.session_count) AS sessions,
                       SUM(c.bytes) AS total
                FROM chart_hourly c
                JOIN geo_locations g ON g.ip = c.remote_address
                WHERE c.hour_start >= ?3 AND c.hour_start < ?4
                GROUP BY g.latitude, g.longitude, g.country_code, g.city
                UNION ALL
                SELECT g.latitude, g.longitude, g.country_code, g.city,
                       COUNT(*) AS sessions,
                       COALESCE(SUM(COALESCE(o.bytes_in,0) + COALESCE(o.bytes_out,0)), 0) AS total
                FROM observations o
                JOIN geo_locations g ON g.ip = o.remote_address
                WHERE o.last_observed_at >= ?1 AND o.last_observed_at < ?2
                  AND (o.last_observed_at < ?3 OR o.last_observed_at >= ?4)
                GROUP BY g.latitude, g.longitude, g.country_code, g.city
                UNION ALL
                SELECT g.latitude, g.longitude, g.country_code, g.city,
                       SUM(r.session_count) AS sessions,
                       SUM(r.bytes_in + r.bytes_out) AS total
                FROM hourly_rollup r
                JOIN geo_locations g ON g.ip = r.remote_address
                WHERE r.hour_start >= ?1 AND r.hour_start < ?2
                  AND r.hour_start NOT IN (SELECT hour_start FROM chart_hourly)
                GROUP BY g.latitude, g.longitude, g.country_code, g.city
            )
            GROUP BY latitude, longitude, country_code, city
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)
            sqlite3_bind_double(statement, 3, ranges.aggregateStart)
            sqlite3_bind_double(statement, 4, ranges.aggregateEnd)
            var placed: [PlacedDestination] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                placed.append(PlacedDestination(
                    latitude: sqlite3_column_double(statement, 0),
                    longitude: sqlite3_column_double(statement, 1),
                    countryCode: text(statement, 2),
                    city: text(statement, 3),
                    sessionCount: Int(sqlite3_column_int64(statement, 4)),
                    bytes: UInt64(max(0, sqlite3_column_int64(statement, 5)))
                ))
            }

            let unplaced = try prepare("""
            SELECT SUM(sessions), SUM(total) FROM (
                SELECT COALESCE(SUM(c.session_count), 0) AS sessions,
                       COALESCE(SUM(c.bytes), 0) AS total
                FROM chart_hourly c
                WHERE c.hour_start >= ?3 AND c.hour_start < ?4
                  AND NOT EXISTS (SELECT 1 FROM geo_locations g WHERE g.ip = c.remote_address)
                UNION ALL
                SELECT COUNT(*) AS sessions,
                       COALESCE(SUM(COALESCE(bytes_in,0) + COALESCE(bytes_out,0)), 0) AS total
                FROM observations o
                WHERE o.last_observed_at >= ?1 AND o.last_observed_at < ?2
                  AND (o.last_observed_at < ?3 OR o.last_observed_at >= ?4)
                  AND NOT EXISTS (SELECT 1 FROM geo_locations g WHERE g.ip = o.remote_address)
                UNION ALL
                SELECT COALESCE(SUM(r.session_count), 0) AS sessions,
                       COALESCE(SUM(r.bytes_in + r.bytes_out), 0) AS total
                FROM hourly_rollup r
                WHERE r.hour_start >= ?1 AND r.hour_start < ?2
                  AND r.hour_start NOT IN (SELECT hour_start FROM chart_hourly)
                  AND NOT EXISTS (SELECT 1 FROM geo_locations g WHERE g.ip = r.remote_address)
            )
            """)
            defer { sqlite3_finalize(unplaced) }
            sqlite3_bind_double(unplaced, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(unplaced, 2, to.timeIntervalSince1970)
            sqlite3_bind_double(unplaced, 3, ranges.aggregateStart)
            sqlite3_bind_double(unplaced, 4, ranges.aggregateEnd)
            var sessions = 0
            var bytes: UInt64 = 0
            if sqlite3_step(unplaced) == SQLITE_ROW {
                sessions = Int(sqlite3_column_int64(unplaced, 0))
                bytes = UInt64(max(0, sqlite3_column_int64(unplaced, 1)))
            }
            return (placed, sessions, bytes)
        }
    }

    public func statistics() throws -> ObservationStoreStatistics {
        try lock.withLock {
            let size = (try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size])
                .flatMap { ($0 as? NSNumber)?.int64Value } ?? 0
            let oldestRaw = try scalarDouble("SELECT MIN(last_observed_at) FROM observations")
            let oldestRollup = try scalarDouble("SELECT MIN(hour_start) FROM hourly_rollup")
            let newest = try scalarDouble("SELECT MAX(last_observed_at) FROM observations")
            let oldest = [oldestRaw, oldestRollup].compactMap { $0 }.min()
            return ObservationStoreStatistics(
                rawCount: try scalar("SELECT COUNT(*) FROM observations") ?? 0,
                rolledUpCount: try scalar("SELECT COUNT(*) FROM hourly_rollup") ?? 0,
                oldestObservedAt: oldest.map { Date(timeIntervalSince1970: $0) },
                newestObservedAt: newest.map { Date(timeIntervalSince1970: $0) },
                monitoringStartedAt: try monitoringStartedAtLocked(),
                fileSizeBytes: size
            )
        }
    }

    // MARK: - Retention

    /// Folds raw rows older than the raw window into hourly totals, then drops
    /// everything past the retention period.
    ///
    /// Returns the number of raw rows folded, so the caller can tell "nothing
    /// to do" from "did not run".
    @discardableResult
    public func compact(now: Date = Date()) throws -> Int {
        try lock.withLock {
            let rawCutoff = now.addingTimeInterval(-Double(retention.rawDays) * 86_400)
            let retentionCutoff = now.addingTimeInterval(-Double(retention.retentionDays) * 86_400)
            try execute("BEGIN IMMEDIATE")
            do {
                let folded = try scalar(
                    "SELECT COUNT(*) FROM observations WHERE last_observed_at < ?",
                    bindDouble: rawCutoff.timeIntervalSince1970
                ) ?? 0
                // Summing into an existing row keeps repeated runs idempotent
                // in effect: an hour folded twice accumulates the right totals
                // because the raw rows are deleted in the same transaction.
                try execute("""
                INSERT INTO hourly_rollup (
                    hour_start, process_name, bundle_id, remote_address,
                    session_count, bytes_in, bytes_out
                )
                SELECT CAST(last_observed_at / 3600 AS INTEGER) * 3600.0,
                       process_name, bundle_id, remote_address,
                       COUNT(*), SUM(COALESCE(bytes_in, 0)), SUM(COALESCE(bytes_out, 0))
                FROM observations
                WHERE last_observed_at < \(rawCutoff.timeIntervalSince1970)
                GROUP BY 1, process_name, bundle_id, remote_address
                ON CONFLICT(hour_start, process_name, bundle_id, remote_address) DO UPDATE SET
                    session_count = session_count + excluded.session_count,
                    bytes_in = bytes_in + excluded.bytes_in,
                    bytes_out = bytes_out + excluded.bytes_out
                """)
                try execute(
                    "DELETE FROM observations WHERE last_observed_at < "
                    + "\(rawCutoff.timeIntervalSince1970)"
                )
                // Retention has to reach everything, not just this one table:
                // `chart_hourly` was never pruned here, and grew by a measured
                // 1.5 MB a day for as long as the agent ran.
                try deleteHistoryLocked(before: retentionCutoff.timeIntervalSince1970)
                try execute("COMMIT")
                return folded
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    /// Every table that carries observation history, in one place.
    ///
    /// `observations` and `hourly_rollup` used to be the whole list here, and
    /// `chart_hourly` was not on it. Measured on a real store: "delete history
    /// before this date" left 62,142 chart rows behind, 38,780 of them still
    /// carrying the destination host name, and the charts could redraw the
    /// exact hours the user had deleted. Anything derived from observations
    /// and bounded by time belongs in this function, so that the next table
    /// added to the schema is not silently left behind in the same way.
    private func deleteHistoryLocked(before seconds: Double) throws {
        try execute("DELETE FROM hourly_rollup WHERE hour_start < \(seconds)")
        try execute("DELETE FROM chart_hourly WHERE hour_start < \(seconds)")
        try execute(
            "DELETE FROM pending_destination_country WHERE last_observed_at < \(seconds)"
        )
        // A session that spans the cutoff is trimmed, not dropped: the part
        // after the cutoff is still a period this Mac was being watched, and
        // dropping it would report those minutes as unobserved.
        try execute(
            "DELETE FROM coverage_sessions WHERE ended_at IS NOT NULL AND ended_at < \(seconds)"
        )
        try execute(
            "UPDATE coverage_sessions SET started_at = \(seconds) WHERE started_at < \(seconds)"
        )
        try execute(
            "DELETE FROM sleep_periods WHERE ended_at IS NOT NULL AND ended_at < \(seconds)"
        )
        try execute(
            "UPDATE sleep_periods SET started_at = \(seconds) WHERE started_at < \(seconds)"
        )
    }

    /// The hour containing the cutoff is deleted whole, because part of it is
    /// data the user asked to remove. What survived of that hour is still
    /// theirs, so fold it again from the rows that remain -- otherwise the
    /// chart, which reads this table for every hour below the watermark, would
    /// show an empty hour where observations still exist.
    private func refoldBoundaryHourLocked(cutoff seconds: Double) throws {
        let boundaryHour = (seconds / 3600).rounded(.down) * 3600
        guard boundaryHour < seconds else { return }
        // At or above the watermark the hour has not been folded yet, and the
        // next fold would add its totals to whatever this wrote.
        let watermark = try scalarDouble("SELECT folded_through FROM chart_hourly_state") ?? 0
        guard boundaryHour < watermark else { return }
        try execute("""
        INSERT INTO chart_hourly (
            hour_start, process_name, remote_address, remote_hostname,
            session_count, bytes, unknown_bytes
        )
        SELECT \(boundaryHour), process_name, remote_address,
               COALESCE(NULLIF(remote_hostname, ''), ''),
               COUNT(*),
               SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)),
               SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END)
        FROM observations
        WHERE last_observed_at >= \(seconds)
          AND last_observed_at < \(boundaryHour + 3600)
        GROUP BY process_name, remote_address, 4
        """)
    }

    /// The country list is an all-time accumulator, so a cutoff cannot trim it:
    /// a row's first visit and its count come partly from hours that no longer
    /// exist. Rebuilding it from what remains is exact, and it is the only
    /// option that neither keeps a deleted fact nor invents a replacement.
    private func rebuildCountryVisitsLocked(now: Date) throws {
        try execute("DELETE FROM country_visit_summary")
        try execute(
            "UPDATE country_visit_state SET retained_history_backfilled_at = NULL WHERE id = 1"
        )
        pendingCountryUpdates.removeAll(keepingCapacity: true)
        knownVisitedCountries.removeAll()
        // Without geo data there is nothing to rebuild from; the flag stays
        // clear, so the next scheduled backfill does it once geo arrives.
        _ = try backfillCountryVisitsLocked(now: now)
    }

    /// The raw rows a deletion with this cutoff would remove.
    ///
    /// Exists so that "save a copy before deleting" can offer a copy of
    /// exactly what is about to go, rather than of whatever period a chart
    /// happened to be showing. `nil` means the whole store, which is what the
    /// delete-everything button removes.
    ///
    /// Raw rows only: hours already reduced to totals have no individual
    /// records left to write, and the caller has to say so rather than hand
    /// over a file that looks complete.
    public func observations(before cutoff: Date?, limit: Int = Int.max) throws
        -> [ConnectionObservation] {
        guard let cutoff else { return try observations(since: nil, limit: limit) }
        return try observations(since: nil, limit: limit)
            .filter { $0.lastObservedAt < cutoff }
    }

    /// "Delete history before this date", which the JSON Lines journal could
    /// not do -- it could only delete everything.
    @discardableResult
    public func removeObservations(before cutoff: Date) throws -> Int {
        try lock.withLock {
            let seconds = cutoff.timeIntervalSince1970
            let removed = try scalar(
                "SELECT COUNT(*) FROM observations WHERE last_observed_at < ?",
                bindDouble: seconds
            ) ?? 0
            // One transaction: a deletion that stops half way through is the
            // failure this whole function exists to prevent.
            try execute("BEGIN IMMEDIATE")
            do {
                try execute("DELETE FROM observations WHERE last_observed_at < \(seconds)")
                try deleteHistoryLocked(before: seconds)
                try refoldBoundaryHourLocked(cutoff: seconds)
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
            try rebuildCountryVisitsLocked(now: Date())
            return removed
        }
    }

    @discardableResult
    public func removeAll() throws -> Int {
        try lock.withLock {
            let removed = try scalar("SELECT COUNT(*) FROM observations") ?? 0
            try execute("DELETE FROM observations")
            try execute("DELETE FROM hourly_rollup")
            try execute("DELETE FROM chart_hourly")
            try execute("DELETE FROM chart_hourly_state")
            try execute("DELETE FROM country_visit_summary")
            try execute("DELETE FROM pending_destination_country")
            try execute("DELETE FROM country_visit_state")
            knownVisitedCountries.removeAll()
            pendingCountryUpdates.removeAll()
            countryByAddressCache.removeAll()
            unresolvedCountryAddresses.removeAll()
            try execute("VACUUM")
            return removed
        }
    }

    // MARK: - Period-independent country history

    private func loadVisitedCountryCodes() throws -> Set<String> {
        let statement = try prepare("SELECT country_code FROM country_visit_summary")
        defer { sqlite3_finalize(statement) }
        var result: Set<String> = []
        while sqlite3_step(statement) == SQLITE_ROW {
            if let code = text(statement, 0) { result.insert(code) }
        }
        return result
    }

    private func recordCountryVisitsLocked(
        _ observations: [ConnectionObservation], now: Date
    ) throws {
        var byAddress: [String: CountryVisitAccumulator] = [:]
        for observation in observations {
            let item = CountryVisitAccumulator(
                firstObservedAt: observation.firstObservedAt,
                lastObservedAt: observation.lastObservedAt,
                lastSiteName: observation.remoteHostname ?? "",
                lastProcessName: observation.processName,
                connectionCount: 1
            )
            if var current = byAddress[observation.remoteAddress] {
                current.merge(item)
                byAddress[observation.remoteAddress] = current
            } else {
                byAddress[observation.remoteAddress] = item
            }
        }

        let countryCodes = try countryCodesForAddressesLocked(Array(byAddress.keys))
        var byCountry: [String: CountryVisitAccumulator] = [:]
        var unresolved: [String: CountryVisitAccumulator] = [:]
        for (address, item) in byAddress {
            guard let code = countryCodes[address] else {
                unresolved[address] = item
                continue
            }
            if var current = byCountry[code] {
                current.merge(item)
                byCountry[code] = current
            } else {
                byCountry[code] = item
            }
        }

        if !unresolved.isEmpty { try upsertPendingDestinationsLocked(unresolved) }

        var immediate: [String: CountryVisitAccumulator] = [:]
        for (code, item) in byCountry {
            if !knownVisitedCountries.contains(code) {
                immediate[code] = item
            } else if var current = pendingCountryUpdates[code] {
                current.merge(item)
                pendingCountryUpdates[code] = current
            } else {
                pendingCountryUpdates[code] = item
            }
        }
        if !immediate.isEmpty {
            try upsertCountryRowsLocked(immediate)
            knownVisitedCountries.formUnion(immediate.keys)
        }

        if now.timeIntervalSince(lastCountrySummaryFlush) >= countrySummaryFlushInterval {
            try flushCountryUpdatesLocked(now: now)
        }
    }

    private func countryCodesForAddressesLocked(_ addresses: [String]) throws -> [String: String] {
        if countryByAddressCache.count + unresolvedCountryAddresses.count > 4_096 {
            countryByAddressCache.removeAll(keepingCapacity: true)
            unresolvedCountryAddresses.removeAll(keepingCapacity: true)
        }
        var result: [String: String] = [:]
        var missing: [String] = []
        for address in Set(addresses) {
            if let code = countryByAddressCache[address] {
                result[address] = code
            } else if !unresolvedCountryAddresses.contains(address) {
                missing.append(address)
            }
        }

        for start in stride(from: 0, to: missing.count, by: 400) {
            let chunk = Array(missing[start..<min(start + 400, missing.count)])
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ",")
            let statement = try prepare("""
            SELECT ip, country_code FROM geo_locations
            WHERE country_code IS NOT NULL AND ip IN (\(placeholders))
            """)
            defer { sqlite3_finalize(statement) }
            for (index, address) in chunk.enumerated() {
                bindText(statement, Int32(index + 1), address)
            }
            var resolved: Set<String> = []
            while sqlite3_step(statement) == SQLITE_ROW {
                guard let address = text(statement, 0),
                      let rawCode = text(statement, 1) else { continue }
                let code = rawCode.uppercased()
                guard code.count == 2, code.allSatisfy({ $0.isASCII && $0.isLetter }) else { continue }
                resolved.insert(address)
                result[address] = code
                countryByAddressCache[address] = code
            }
            for address in chunk where !resolved.contains(address) {
                unresolvedCountryAddresses.insert(address)
            }
        }
        return result
    }

    private func upsertCountryRowsLocked(_ rows: [String: CountryVisitAccumulator]) throws {
        guard !rows.isEmpty else { return }
        let statement = try prepare("""
        INSERT INTO country_visit_summary (
            country_code, first_observed_at, last_observed_at,
            last_site_name, last_process_name, connection_count
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(country_code) DO UPDATE SET
            first_observed_at = min(first_observed_at, excluded.first_observed_at),
            last_site_name = CASE
                WHEN excluded.last_observed_at >= last_observed_at
                 AND excluded.last_site_name <> '' THEN excluded.last_site_name
                ELSE last_site_name END,
            last_process_name = CASE
                WHEN excluded.last_observed_at >= last_observed_at
                THEN excluded.last_process_name ELSE last_process_name END,
            last_observed_at = max(last_observed_at, excluded.last_observed_at),
            connection_count = connection_count + excluded.connection_count
        """)
        defer { sqlite3_finalize(statement) }
        for (code, item) in rows {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            bindText(statement, 1, code)
            sqlite3_bind_double(statement, 2, item.firstObservedAt.timeIntervalSince1970)
            sqlite3_bind_double(statement, 3, item.lastObservedAt.timeIntervalSince1970)
            bindText(statement, 4, item.lastSiteName)
            bindText(statement, 5, item.lastProcessName)
            sqlite3_bind_int64(statement, 6, Int64(item.connectionCount))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw ObservationStoreError.statement(lastMessage)
            }
        }
    }

    private func flushCountryUpdatesLocked(now: Date = Date()) throws {
        if !pendingCountryUpdates.isEmpty {
            try upsertCountryRowsLocked(pendingCountryUpdates)
            pendingCountryUpdates.removeAll(keepingCapacity: true)
        }
        lastCountrySummaryFlush = now
        let cutoff = now.addingTimeInterval(-90 * 86_400).timeIntervalSince1970
        try execute("DELETE FROM pending_destination_country WHERE last_observed_at < \(cutoff)")
        try execute("""
        DELETE FROM pending_destination_country
        WHERE remote_address IN (
            SELECT remote_address FROM pending_destination_country
            ORDER BY last_observed_at DESC LIMIT -1 OFFSET 50000
        )
        """)
    }

    private func upsertPendingDestinationsLocked(
        _ rows: [String: CountryVisitAccumulator]
    ) throws {
        let statement = try prepare("""
        INSERT INTO pending_destination_country (
            remote_address, last_site_name, last_process_name,
            first_observed_at, last_observed_at, connection_count
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(remote_address) DO UPDATE SET
            first_observed_at = min(first_observed_at, excluded.first_observed_at),
            last_site_name = CASE
                WHEN excluded.last_observed_at >= last_observed_at
                 AND excluded.last_site_name <> '' THEN excluded.last_site_name
                ELSE last_site_name END,
            last_process_name = CASE
                WHEN excluded.last_observed_at >= last_observed_at
                THEN excluded.last_process_name ELSE last_process_name END,
            last_observed_at = max(last_observed_at, excluded.last_observed_at),
            connection_count = connection_count + excluded.connection_count
        """)
        defer { sqlite3_finalize(statement) }
        for (address, item) in rows {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            bindText(statement, 1, address)
            bindText(statement, 2, item.lastSiteName)
            bindText(statement, 3, item.lastProcessName)
            sqlite3_bind_double(statement, 4, item.firstObservedAt.timeIntervalSince1970)
            sqlite3_bind_double(statement, 5, item.lastObservedAt.timeIntervalSince1970)
            sqlite3_bind_int64(statement, 6, Int64(item.connectionCount))
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw ObservationStoreError.statement(lastMessage)
            }
        }
    }

    private func backfillCountryVisitsLocked(now: Date) throws -> Bool {
        guard (try scalar("""
            SELECT COUNT(*) FROM country_visit_state
            WHERE id = 1 AND retained_history_backfilled_at IS NOT NULL
            """) ?? 0) == 0 else { return false }
        guard (try scalar("SELECT COUNT(*) FROM geo_locations") ?? 0) > 0 else { return false }

        // `INSERT OR IGNORE` matters if collection starts while this utility
        // task is waiting for the store lock. A newly written country is more
        // current than the historical seed and must not have its count doubled.
        try execute("""
        WITH watermark AS (
            SELECT COALESCE((SELECT folded_through FROM chart_hourly_state WHERE id = 1), 0)
                   AS folded_through
        ), history AS (
            SELECT upper(g.country_code) AS country_code,
                   c.hour_start AS first_seen,
                   c.hour_start + 3599 AS last_seen,
                   c.remote_hostname AS site_name,
                   c.process_name AS process_name,
                   c.session_count AS connection_count
            FROM chart_hourly c
            JOIN geo_locations g ON g.ip = c.remote_address
            CROSS JOIN watermark w
            WHERE g.country_code IS NOT NULL AND c.hour_start < w.folded_through
            UNION ALL
            SELECT upper(g.country_code), o.first_observed_at, o.last_observed_at,
                   COALESCE(o.remote_hostname, ''), o.process_name, 1
            FROM observations o
            JOIN geo_locations g ON g.ip = o.remote_address
            CROSS JOIN watermark w
            WHERE g.country_code IS NOT NULL AND o.last_observed_at >= w.folded_through
        ), ranked AS (
            SELECT *, ROW_NUMBER() OVER (
                PARTITION BY country_code ORDER BY last_seen DESC
            ) AS recency
            FROM history
            WHERE length(country_code) = 2
        )
        INSERT OR IGNORE INTO country_visit_summary (
            country_code, first_observed_at, last_observed_at,
            last_site_name, last_process_name, connection_count
        )
        SELECT country_code, MIN(first_seen), MAX(last_seen),
               COALESCE(MAX(CASE WHEN recency = 1 THEN site_name END), ''),
               COALESCE(MAX(CASE WHEN recency = 1 THEN process_name END), ''),
               SUM(connection_count)
        FROM ranked
        GROUP BY country_code
        """)
        try execute("""
        INSERT INTO country_visit_state (id, retained_history_backfilled_at)
        VALUES (1, \(now.timeIntervalSince1970))
        ON CONFLICT(id) DO UPDATE SET
            retained_history_backfilled_at = excluded.retained_history_backfilled_at
        """)
        knownVisitedCountries = try loadVisitedCountryCodes()
        return true
    }

    private func resolvePendingCountriesLocked() throws {
        let statement = try prepare("""
        SELECT p.remote_address, p.last_site_name, p.last_process_name,
               p.first_observed_at, p.last_observed_at, p.connection_count,
               upper(g.country_code)
        FROM pending_destination_country p
        JOIN geo_locations g ON g.ip = p.remote_address
        WHERE g.country_code IS NOT NULL
        """)
        defer { sqlite3_finalize(statement) }
        var byCountry: [String: CountryVisitAccumulator] = [:]
        var resolvedAddresses: [String] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            guard let address = text(statement, 0), let code = text(statement, 6),
                  code.count == 2 else { continue }
            resolvedAddresses.append(address)
            let item = CountryVisitAccumulator(
                firstObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 3)),
                lastObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 4)),
                lastSiteName: text(statement, 1) ?? "",
                lastProcessName: text(statement, 2) ?? "",
                connectionCount: Int(sqlite3_column_int64(statement, 5))
            )
            if var current = byCountry[code] {
                current.merge(item)
                byCountry[code] = current
            } else {
                byCountry[code] = item
            }
        }
        try upsertCountryRowsLocked(byCountry)
        knownVisitedCountries.formUnion(byCountry.keys)
        guard !resolvedAddresses.isEmpty else { return }
        for start in stride(from: 0, to: resolvedAddresses.count, by: 400) {
            let chunk = Array(resolvedAddresses[start..<min(start + 400, resolvedAddresses.count)])
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ",")
            let deletion = try prepare(
                "DELETE FROM pending_destination_country WHERE remote_address IN (\(placeholders))"
            )
            for (index, address) in chunk.enumerated() {
                bindText(deletion, Int32(index + 1), address)
            }
            guard sqlite3_step(deletion) == SQLITE_DONE else {
                sqlite3_finalize(deletion)
                throw ObservationStoreError.statement(lastMessage)
            }
            sqlite3_finalize(deletion)
        }
    }

    // MARK: - SQLite plumbing

    private var lastMessage: String {
        handle.flatMap { sqlite3_errmsg($0) }.map { String(cString: $0) } ?? "unknown SQLite error"
    }

    private func insert(_ observations: [ConnectionObservation]) throws {
        let sql = """
        INSERT INTO observations (
            network_protocol, local_address, local_port, remote_address, remote_port,
            process_id, process_name, bundle_id, first_observed_at, last_observed_at,
            bytes_in, bytes_out, collector, confidence, remote_hostname, flow_id
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(flow_id) WHERE flow_id IS NOT NULL DO UPDATE SET
            process_name = excluded.process_name,
            bundle_id = coalesce(excluded.bundle_id, observations.bundle_id),
            first_observed_at = min(observations.first_observed_at, excluded.first_observed_at),
            last_observed_at = max(observations.last_observed_at, excluded.last_observed_at),
            bytes_in = coalesce(excluded.bytes_in, observations.bytes_in),
            bytes_out = coalesce(excluded.bytes_out, observations.bytes_out),
            collector = excluded.collector,
            confidence = excluded.confidence,
            remote_hostname = coalesce(excluded.remote_hostname, observations.remote_hostname)
        """
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        for observation in observations {
            sqlite3_reset(statement)
            sqlite3_clear_bindings(statement)
            bindText(statement, 1, observation.networkProtocol.rawValue)
            bindText(statement, 2, observation.localAddress)
            sqlite3_bind_int64(statement, 3, Int64(observation.localPort))
            bindText(statement, 4, observation.remoteAddress)
            sqlite3_bind_int64(statement, 5, Int64(observation.remotePort))
            sqlite3_bind_int64(statement, 6, Int64(observation.processID))
            bindText(statement, 7, observation.processName)
            bindOptionalText(statement, 8, observation.bundleID)
            sqlite3_bind_double(statement, 9, observation.firstObservedAt.timeIntervalSince1970)
            sqlite3_bind_double(statement, 10, observation.lastObservedAt.timeIntervalSince1970)
            bindOptionalInt(statement, 11, observation.bytesIn)
            bindOptionalInt(statement, 12, observation.bytesOut)
            bindText(statement, 13, observation.collector.rawValue)
            bindText(statement, 14, observation.confidence.rawValue)
            bindOptionalText(statement, 15, observation.remoteHostname)
            bindOptionalText(statement, 16, observation.flowID?.uuidString)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw ObservationStoreError.statement(lastMessage)
            }
        }
    }

    /// Country history counts connections, not opening/closing reports. Merge
    /// duplicate reports in this batch and exclude flows already present in
    /// SQLite before updating the period-independent country counters.
    private func newFlowObservationsForCountryHistory(
        _ observations: [ConnectionObservation]
    ) throws -> [ConnectionObservation] {
        var withoutFlowID: [ConnectionObservation] = []
        var byFlowID: [UUID: ConnectionObservation] = [:]
        for observation in observations {
            guard let flowID = observation.flowID else {
                withoutFlowID.append(observation)
                continue
            }
            byFlowID[flowID] = byFlowID[flowID].map { $0.merging(observation) } ?? observation
        }
        guard !byFlowID.isEmpty else { return withoutFlowID }
        let existing = try existingFlowIDs(Set(byFlowID.keys))
        withoutFlowID.append(contentsOf: byFlowID.compactMap { flowID, observation in
            existing.contains(flowID) ? nil : observation
        })
        return withoutFlowID
    }

    private func existingFlowIDs(_ flowIDs: Set<UUID>) throws -> Set<UUID> {
        var result: Set<UUID> = []
        let values = Array(flowIDs)
        for start in stride(from: 0, to: values.count, by: 400) {
            let chunk = Array(values[start..<min(start + 400, values.count)])
            let placeholders = Array(repeating: "?", count: chunk.count).joined(separator: ",")
            let statement = try prepare(
                "SELECT flow_id FROM observations WHERE flow_id IN (\(placeholders))"
            )
            for (index, flowID) in chunk.enumerated() {
                bindText(statement, Int32(index + 1), flowID.uuidString)
            }
            while sqlite3_step(statement) == SQLITE_ROW {
                if let value = text(statement, 0), let flowID = UUID(uuidString: value) {
                    result.insert(flowID)
                }
            }
            sqlite3_finalize(statement)
        }
        return result
    }

    private func importedLegacyCount(fingerprint: String) throws -> Int? {
        let statement = try prepare(
            "SELECT observation_count FROM legacy_imports WHERE fingerprint = ?"
        )
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, fingerprint)
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func execute(_ sql: String) throws {
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw ObservationStoreError.statement("\(lastMessage) — \(sql.prefix(120))")
        }
    }

    private func prepare(_ sql: String) throws -> OpaquePointer? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK else {
            throw ObservationStoreError.statement("\(lastMessage) — \(sql.prefix(120))")
        }
        return statement
    }

    private func scalar(_ sql: String, bindDouble: Double? = nil) throws -> Int? {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        if let bindDouble { sqlite3_bind_double(statement, 1, bindDouble) }
        guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func scalarDouble(_ sql: String) throws -> Double? {
        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW,
              sqlite3_column_type(statement, 0) != SQLITE_NULL else { return nil }
        return sqlite3_column_double(statement, 0)
    }

    private func bindText(_ statement: OpaquePointer?, _ index: Int32, _ value: String) {
        sqlite3_bind_text(statement, index, value, -1, SQLITE_TRANSIENT)
    }

    private func bindOptionalText(_ statement: OpaquePointer?, _ index: Int32, _ value: String?) {
        if let value {
            bindText(statement, index, value)
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func bindOptionalInt(_ statement: OpaquePointer?, _ index: Int32, _ value: UInt64?) {
        if let value {
            sqlite3_bind_int64(statement, index, Int64(clamping: value))
        } else {
            sqlite3_bind_null(statement, index)
        }
    }

    private func text(_ statement: OpaquePointer?, _ index: Int32) -> String? {
        sqlite3_column_text(statement, index).map { String(cString: $0) }
    }

    private func decodeObservation(_ statement: OpaquePointer?) -> ConnectionObservation {
        func optionalUInt(_ index: Int32) -> UInt64? {
            sqlite3_column_type(statement, index) == SQLITE_NULL
                ? nil
                : UInt64(max(0, sqlite3_column_int64(statement, index)))
        }
        return ConnectionObservation(
            networkProtocol: InternetProtocol(rawValue: text(statement, 1) ?? "tcp") ?? .tcp,
            localAddress: text(statement, 2) ?? "",
            localPort: UInt16(truncatingIfNeeded: sqlite3_column_int64(statement, 3)),
            remoteAddress: text(statement, 4) ?? "",
            remotePort: UInt16(truncatingIfNeeded: sqlite3_column_int64(statement, 5)),
            processID: Int32(truncatingIfNeeded: sqlite3_column_int64(statement, 6)),
            processName: text(statement, 7) ?? "",
            bundleID: text(statement, 8),
            firstObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 9)),
            lastObservedAt: Date(timeIntervalSince1970: sqlite3_column_double(statement, 10)),
            bytesIn: optionalUInt(11),
            bytesOut: optionalUInt(12),
            collector: CollectorKind(rawValue: text(statement, 13) ?? "libproc") ?? .libproc,
            confidence: ObservationConfidence(rawValue: text(statement, 14) ?? "exact") ?? .exact,
            remoteHostname: text(statement, 15),
            flowID: text(statement, 16).flatMap(UUID.init(uuidString:))
        )
    }
}
