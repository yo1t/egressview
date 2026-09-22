import SQLite3
import XCTest
@testable import EgressViewAgentCore

/// Opening the database is the first thing the agent does and, on a large one,
/// the longest. Until now it did it silently and without a way back: a
/// migration that failed halfway had nothing to restore from, and while it ran
/// the agent was indistinguishable from a broken one (P3-161).
final class MigrationBackupTests: XCTestCase {
    private var url: URL!

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("migration-\(UUID().uuidString).sqlite")
    }

    override func tearDownWithError() throws {
        let directory = url.deletingLastPathComponent()
        let prefix = url.deletingPathExtension().lastPathComponent
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        where name.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    /// Rolls the schema back so the next open has to migrate, the way an
    /// upgrade does.
    ///
    /// Only to 14. The steps are not written to be replayed -- an earlier
    /// version would try to add a column that is already there -- so the test
    /// re-runs the one step that can be, which is enough to exercise the
    /// backup and the progress file around it.
    private func rollBackSchema(to version: Int) throws {
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &handle), SQLITE_OK)
        defer { sqlite3_close_v2(handle) }
        XCTAssertEqual(
            sqlite3_exec(handle, "PRAGMA user_version=\(version)", nil, nil, nil), SQLITE_OK
        )
    }

    private func observe(_ store: ObservationStore, at date: Date) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: "203.0.113.7", remotePort: 443, processID: 1,
            processName: "curl", bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: "one.example"
        )])
    }

    private func backupNames() -> [String] {
        let directory = url.deletingLastPathComponent()
        let prefix = url.deletingPathExtension().lastPathComponent
        return ((try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? [])
            .filter { $0.hasPrefix(prefix) && $0.contains("pre-v") }
    }

    func test移行の前に複製を作る() throws {
        let store = try ObservationStore(fileURL: url)
        try observe(store, at: Date(timeIntervalSince1970: 1_700_000_000))
        _ = store

        try rollBackSchema(to: 14)
        _ = try ObservationStore(fileURL: url)

        let backups = backupNames()
        XCTAssertEqual(backups.count, 1, "移行前の複製が作られていない: \(backups)")
        XCTAssertTrue(backups[0].contains("pre-v14"), "どの版から上げたのかが名前に無い")

        // The copy has to be a database, not an empty file: a backup nobody can
        // open is the same as no backup, discovered at the worst moment.
        let copy = url.deletingLastPathComponent().appendingPathComponent(backups[0])
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open(copy.path, &handle), SQLITE_OK)
        defer { sqlite3_close_v2(handle) }
        var statement: OpaquePointer?
        XCTAssertEqual(
            sqlite3_prepare_v2(handle, "SELECT COUNT(*) FROM observations", -1, &statement, nil),
            SQLITE_OK
        )
        defer { sqlite3_finalize(statement) }
        XCTAssertEqual(sqlite3_step(statement), SQLITE_ROW)
        XCTAssertEqual(sqlite3_column_int(statement, 0), 1, "複製に記録が入っていない")
    }

    func test新しいデータベースでは複製を作らない() throws {
        _ = try ObservationStore(fileURL: url)
        XCTAssertEqual(backupNames(), [], "失うものが無いのに複製を作っている")
    }

    func test移行が終われば進捗の記録は消える() throws {
        let store = try ObservationStore(fileURL: url)
        try observe(store, at: Date(timeIntervalSince1970: 1_700_000_000))
        _ = store
        try rollBackSchema(to: 14)
        _ = try ObservationStore(fileURL: url)

        XCTAssertNil(
            MigrationProgressFile.read(forDatabaseAt: url),
            "終わったのに「更新中」と言い続けるファイルが残っている"
        )
    }

    func test進捗は段階と手順で言う() {
        // Not a percentage. The reader's question is whether anything is
        // happening at all, and a number that does not move for a minute
        // answers it worse than naming the step.
        let backingUp = MigrationProgress(stage: .backingUp, fromVersion: 9, toVersion: 15)
        XCTAssertNil(backingUp.step, "複製の段階に手順番号は無い")

        let migrating = MigrationProgress(
            stage: .migrating, fromVersion: 9, toVersion: 15, currentVersion: 11
        )
        XCTAssertEqual(migrating.step?.current, 3)
        XCTAssertEqual(migrating.step?.total, 6)
    }

    func test進捗は書いた側の外から読める() throws {
        // The whole point of the file: the window cannot ask the agent, because
        // the agent is the thing that has not finished starting.
        let progress = MigrationProgress(
            stage: .migrating, fromVersion: 9, toVersion: 15, currentVersion: 12
        )
        MigrationProgressFile.write(progress, forDatabaseAt: url)
        defer { MigrationProgressFile.clear(forDatabaseAt: url) }

        let read = try XCTUnwrap(MigrationProgressFile.read(forDatabaseAt: url))
        XCTAssertEqual(read.stage, progress.stage)
        XCTAssertEqual(read.fromVersion, progress.fromVersion)
        XCTAssertEqual(read.toVersion, progress.toVersion)
        XCTAssertEqual(read.currentVersion, progress.currentVersion)
        // Written as ISO 8601, which keeps whole seconds.
        XCTAssertEqual(
            read.startedAt.timeIntervalSince1970,
            progress.startedAt.timeIntervalSince1970, accuracy: 1
        )
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: MigrationProgressFile.fileURL(forDatabaseAt: url).path
            )
        )
    }
}
