import Foundation
import XCTest
@testable import EgressViewAgentCore

final class ObservationJournalMigrationTests: XCTestCase {
    private var directory: URL!
    private var journalURL: URL!
    private var storeURL: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-journal-migration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        journalURL = directory.appendingPathComponent("observations.jsonl")
        storeURL = directory.appendingPathComponent("observations.sqlite")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testImportsBothJournalGenerationsAndRemovesCleanSources() throws {
        let journal = ObservationJournal(fileURL: journalURL, maximumFileSize: 1_024)
        let first = observation(remote: "203.0.113.10", process: "Safari")
        let second = observation(remote: "203.0.113.11", process: String(repeating: "Mail", count: 100))
        try journal.append([first])
        try journal.append([second])
        XCTAssertTrue(FileManager.default.fileExists(atPath: journalURL.appendingPathExtension("1").path))

        let store = try ObservationStore(fileURL: storeURL)
        let result = try ObservationJournalMigrator.migrate(journal: journal, into: store)

        XCTAssertEqual(result.importedCount, 2)
        XCTAssertEqual(result.malformedLineCount, 0)
        XCTAssertTrue(result.sourceFilesRemoved)
        XCTAssertFalse(result.wasAlreadyImported)
        XCTAssertEqual(Set(try store.observations().map(\.remoteAddress)), ["203.0.113.10", "203.0.113.11"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: journalURL.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: journalURL.appendingPathExtension("1").path))
    }

    func testImportMarkerPreventsDuplicatesAfterACrashBeforeCleanup() throws {
        let journal = ObservationJournal(fileURL: journalURL)
        try journal.append([observation(remote: "203.0.113.20")])
        let batch = try XCTUnwrap(journal.migrationBatch())
        let store = try ObservationStore(fileURL: storeURL)

        XCTAssertEqual(try store.importLegacyJournal(batch), .imported(1))
        XCTAssertEqual(try store.importLegacyJournal(batch), .alreadyImported(1))
        XCTAssertEqual(try store.statistics().rawCount, 1)
    }

    func testChangedJournalIsNotDeletedAfterTheSnapshotWasImported() throws {
        let journal = ObservationJournal(fileURL: journalURL)
        try journal.append([observation(remote: "203.0.113.30")])
        let batch = try XCTUnwrap(journal.migrationBatch())
        let store = try ObservationStore(fileURL: storeURL)
        _ = try store.importLegacyJournal(batch)

        try journal.append([observation(remote: "203.0.113.31")])

        XCTAssertFalse(try journal.removeMigratedFiles(matching: batch.fingerprint))
        XCTAssertTrue(FileManager.default.fileExists(atPath: journalURL.path))
    }

    func testMalformedLinesKeepTheLegacySourceForRecovery() throws {
        let journal = ObservationJournal(fileURL: journalURL)
        try journal.append([observation(remote: "203.0.113.40")])
        let handle = try FileHandle(forWritingTo: journalURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("{not-json}\n".utf8))
        try handle.close()
        let store = try ObservationStore(fileURL: storeURL)

        let result = try ObservationJournalMigrator.migrate(journal: journal, into: store)

        XCTAssertEqual(result.importedCount, 1)
        XCTAssertEqual(result.malformedLineCount, 1)
        XCTAssertFalse(result.sourceFilesRemoved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: journalURL.path))
        XCTAssertEqual(try store.statistics().rawCount, 1)
    }

    func testNoLegacyFilesIsANoOp() throws {
        let journal = ObservationJournal(fileURL: journalURL)
        let store = try ObservationStore(fileURL: storeURL)

        XCTAssertEqual(
            try ObservationJournalMigrator.migrate(journal: journal, into: store),
            .noLegacyData
        )
    }

    private func observation(
        remote: String,
        process: String = "Safari"
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: remote,
            remotePort: 443,
            processID: 501,
            processName: process,
            bundleID: "com.example.app",
            firstObservedAt: Date(timeIntervalSince1970: 1_800_000_000),
            lastObservedAt: Date(timeIntervalSince1970: 1_800_000_001),
            bytesIn: nil,
            bytesOut: nil,
            collector: .networkExtension,
            confidence: .exact
        )
    }
}
