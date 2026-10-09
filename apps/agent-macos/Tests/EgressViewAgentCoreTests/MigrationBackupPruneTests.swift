import Foundation
import XCTest
@testable import EgressViewAgentCore

final class MigrationBackupPruneTests: XCTestCase {
    private var directory: URL!
    private var database: URL { directory.appendingPathComponent("observations.sqlite") }

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("prune-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("db".utf8).write(to: database)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func copy(_ version: Int, writtenHoursAgo hours: Double, now: Date) throws -> URL {
        let url = directory.appendingPathComponent("observations.pre-v\(version).sqlite")
        try Data(repeating: 1, count: 100 * version).write(to: url)
        try FileManager.default.setAttributes(
            [.modificationDate: now.addingTimeInterval(-hours * 3600)], ofItemAtPath: url.path
        )
        return url
    }

    func test_24時間を過ぎた複製だけを消し本体は残す() throws {
        let now = Date()
        let old15 = try copy(15, writtenHoursAgo: 72, now: now)
        let old16 = try copy(16, writtenHoursAgo: 25, now: now)
        let fresh17 = try copy(17, writtenHoursAgo: 2, now: now)
        let partial = directory.appendingPathComponent("observations.pre-v18.sqlite.partial")
        try Data("x".utf8).write(to: partial)

        let result = MigrationInventory.pruneBackups(forDatabaseAt: database, now: now)

        XCTAssertEqual(result.deleted, 2)
        XCTAssertEqual(result.bytesFreed, 1500 + 1600)
        XCTAssertFalse(FileManager.default.fileExists(atPath: old15.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: old16.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh17.path), "a copy from the last day is kept")
        XCTAssertTrue(FileManager.default.fileExists(atPath: database.path), "the database itself is never touched")
        XCTAssertTrue(FileManager.default.fileExists(atPath: partial.path), "an unfinished copy is not a backup")
    }

    func test_一日たてば最新の複製も消える() throws {
        let now = Date()
        _ = try copy(17, writtenHoursAgo: 2, now: now)
        XCTAssertEqual(MigrationInventory.pruneBackups(forDatabaseAt: database, now: now).deleted, 0)
        XCTAssertEqual(
            MigrationInventory.pruneBackups(forDatabaseAt: database, now: now.addingTimeInterval(23 * 3600)).deleted, 1
        )
        XCTAssertTrue(MigrationInventory.backups(forDatabaseAt: database).isEmpty)
    }
}
