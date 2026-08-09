import EgressViewAgentCore
import Foundation
import XCTest

final class ObservationJournalTests: XCTestCase {
    private var temporaryDirectory: URL!

    override func setUpWithError() throws {
        temporaryDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporaryDirectory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: temporaryDirectory)
    }

    func testLatestReturnsNewestObservationPerStableKey() throws {
        let journal = ObservationJournal(fileURL: temporaryDirectory.appendingPathComponent("observations.jsonl"))
        let first = observation(remoteAddress: "203.0.113.10", observedAt: Date(timeIntervalSince1970: 10))
        let newer = observation(remoteAddress: "203.0.113.10", observedAt: Date(timeIntervalSince1970: 20))
        let other = observation(remoteAddress: "2001:db8::10", observedAt: Date(timeIntervalSince1970: 15))

        try journal.append([first, other])
        try journal.append([newer])

        let latest = try journal.latest()
        XCTAssertEqual(latest.map(\.remoteAddress), ["203.0.113.10", "2001:db8::10"])
        XCTAssertEqual(latest.first?.lastObservedAt, newer.lastObservedAt)
    }

    func testMalformedLineDoesNotHideValidObservations() throws {
        let fileURL = temporaryDirectory.appendingPathComponent("observations.jsonl")
        let journal = ObservationJournal(fileURL: fileURL)
        try journal.append([observation(remoteAddress: "203.0.113.20", observedAt: Date())])
        let handle = try FileHandle(forWritingTo: fileURL)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data("not-json\n".utf8))
        try handle.close()

        XCTAssertEqual(try journal.latest().count, 1)
    }

    func testJournalUsesPrivateFilePermissions() throws {
        let fileURL = temporaryDirectory.appendingPathComponent("observations.jsonl")
        let journal = ObservationJournal(fileURL: fileURL)
        try journal.append([observation(remoteAddress: "203.0.113.30", observedAt: Date())])

        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        XCTAssertEqual(attributes[.posixPermissions] as? NSNumber, NSNumber(value: 0o600))
    }

    func testRotationKeepsCurrentAndPreviousJournal() throws {
        let fileURL = temporaryDirectory.appendingPathComponent("observations.jsonl")
        let journal = ObservationJournal(fileURL: fileURL, maximumFileSize: 1_024)
        let padding = String(repeating: "x", count: 1_100)

        try journal.append([observation(
            remoteAddress: "203.0.113.40",
            observedAt: Date(timeIntervalSince1970: 10),
            processName: padding
        )])
        try journal.append([observation(
            remoteAddress: "203.0.113.41",
            observedAt: Date(timeIntervalSince1970: 20)
        )])

        XCTAssertEqual(Set(try journal.latest().map(\.remoteAddress)), ["203.0.113.40", "203.0.113.41"])
        XCTAssertTrue(FileManager.default.fileExists(atPath: fileURL.appendingPathExtension("1").path))
    }

    func testSeparateJournalInstancesSerializeConcurrentAppends() throws {
        let fileURL = temporaryDirectory.appendingPathComponent("observations.jsonl")
        let journals = [ObservationJournal(fileURL: fileURL), ObservationJournal(fileURL: fileURL)]
        let queue = DispatchQueue(label: "journal-test", attributes: .concurrent)
        let group = DispatchGroup()
        let errors = LockedErrors()
        let observations = (0..<20).map { index in
            observation(
                remoteAddress: "203.0.113.\(index)",
                observedAt: Date(timeIntervalSince1970: TimeInterval(index))
            )
        }

        for index in 0..<20 {
            group.enter()
            queue.async {
                defer { group.leave() }
                do {
                    try journals[index % journals.count].append([observations[index]])
                } catch {
                    errors.append(error)
                }
            }
        }
        group.wait()

        XCTAssertTrue(errors.values.isEmpty)
        XCTAssertEqual(try journals[0].latest(limit: 100).count, 20)
    }

    private func observation(
        remoteAddress: String,
        observedAt: Date,
        processName: String = "TestApp"
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: remoteAddress,
            remotePort: 443,
            processID: 42,
            processName: processName,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            collector: .libproc,
            confidence: .sampled
        )
    }
}

private final class LockedErrors: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Error] = []

    var values: [Error] {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }

    func append(_ error: Error) {
        lock.lock()
        storage.append(error)
        lock.unlock()
    }
}
