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
    public let fileSizeBytes: Int64
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

    public init(fileURL: URL, retention: ObservationRetention = ObservationRetention()) throws {
        self.fileURL = fileURL
        self.retention = retention
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

    // MARK: - Writing

    public func append(_ observations: [ConnectionObservation]) throws {
        guard !observations.isEmpty else { return }
        try lock.withLock {
            try execute("BEGIN IMMEDIATE")
            do {
                try insert(observations)
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
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
            let sql = """
            SELECT process_name,
                   \(destinationExpression) AS destination,
                   COUNT(*) AS sessions,
                   COALESCE(SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)), 0) AS total_bytes,
                   SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END) AS unknown
            FROM observations
            WHERE last_observed_at >= ? AND last_observed_at < ?
            GROUP BY process_name, destination
            ORDER BY sessions DESC
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)

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
    public func appTimeline(from: Date, to: Date, buckets: Int) throws -> [AppTimelineTotal] {
        let bucketCount = max(1, min(240, buckets))
        let span = to.timeIntervalSince(from)
        guard span > 0 else { return [] }
        let width = span / Double(bucketCount)

        return try lock.withLock {
            let sql = """
            SELECT MIN(CAST((last_observed_at - ?1) / ?3 AS INTEGER), ?4) AS bucket,
                   process_name,
                   COUNT(*) AS sessions,
                   COALESCE(SUM(COALESCE(bytes_in, 0) + COALESCE(bytes_out, 0)), 0) AS total_bytes,
                   SUM(CASE WHEN bytes_in IS NULL AND bytes_out IS NULL THEN 1 ELSE 0 END) AS unknown
            FROM observations
            WHERE last_observed_at >= ?1 AND last_observed_at < ?2
            GROUP BY bucket, process_name
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)
            sqlite3_bind_double(statement, 3, width)
            sqlite3_bind_int64(statement, 4, Int64(bucketCount - 1))

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
                try execute("COMMIT")
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
        }
    }

    public func geoLocationCount() throws -> Int {
        try lock.withLock { try scalar("SELECT COUNT(*) FROM geo_locations") ?? 0 }
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
            let sql = """
            SELECT g.latitude, g.longitude, g.country_code, g.city,
                   COUNT(*) AS sessions,
                   COALESCE(SUM(COALESCE(o.bytes_in,0) + COALESCE(o.bytes_out,0)), 0) AS total
            FROM observations o
            JOIN geo_locations g ON g.ip = o.remote_address
            WHERE o.last_observed_at >= ? AND o.last_observed_at < ?
            GROUP BY g.latitude, g.longitude, g.country_code, g.city
            """
            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_double(statement, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(statement, 2, to.timeIntervalSince1970)
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
            SELECT COUNT(*), COALESCE(SUM(COALESCE(bytes_in,0) + COALESCE(bytes_out,0)), 0)
            FROM observations o
            WHERE o.last_observed_at >= ? AND o.last_observed_at < ?
              AND NOT EXISTS (SELECT 1 FROM geo_locations g WHERE g.ip = o.remote_address)
            """)
            defer { sqlite3_finalize(unplaced) }
            sqlite3_bind_double(unplaced, 1, from.timeIntervalSince1970)
            sqlite3_bind_double(unplaced, 2, to.timeIntervalSince1970)
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
                try execute(
                    "DELETE FROM hourly_rollup WHERE hour_start < "
                    + "\(retentionCutoff.timeIntervalSince1970)"
                )
                try execute("COMMIT")
                return folded
            } catch {
                try? execute("ROLLBACK")
                throw error
            }
        }
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
            try execute("DELETE FROM observations WHERE last_observed_at < \(seconds)")
            try execute("DELETE FROM hourly_rollup WHERE hour_start < \(seconds)")
            return removed
        }
    }

    @discardableResult
    public func removeAll() throws -> Int {
        try lock.withLock {
            let removed = try scalar("SELECT COUNT(*) FROM observations") ?? 0
            try execute("DELETE FROM observations")
            try execute("DELETE FROM hourly_rollup")
            try execute("VACUUM")
            return removed
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
            bytes_in, bytes_out, collector, confidence, remote_hostname
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw ObservationStoreError.statement(lastMessage)
            }
        }
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
            remoteHostname: text(statement, 15)
        )
    }
}
