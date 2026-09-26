import Foundation
import SQLite3
import XCTest
@testable import EgressViewAgentCore

// macOS reuses one flow id for a UDP socket that opens and closes again and
// again. Each time is its own connection with its own byte counts, and every
// report of one time carries the start the extension recorded for it.

private let flow = UUID(uuidString: "00000000-0000-0000-0000-0000000000f1")!
private let base = Date(timeIntervalSince1970: 1_800_000_000)

private func report(
    start: TimeInterval, end: TimeInterval, bytesOut: UInt64? = nil, flowID: UUID? = flow
) -> ConnectionObservation {
    ConnectionObservation(
        networkProtocol: .udp,
        localAddress: "192.0.2.10",
        localPort: 55_264,
        remoteAddress: "203.0.113.5",
        remotePort: 52_217,
        processID: 4_201,
        processName: "rapportd",
        bundleID: nil,
        firstObservedAt: base.addingTimeInterval(start),
        lastObservedAt: base.addingTimeInterval(end),
        bytesIn: bytesOut.map { _ in 0 },
        bytesOut: bytesOut,
        collector: .networkExtension,
        confidence: .exact,
        flowID: flowID
    )
}

final class FlowEpisodeStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-episode-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func store() throws -> ObservationStore {
        try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
    }

    func test同じflowが開き直すたびに別の行になりバイト数を失わない() throws {
        let store = try store()
        for minute in 0..<3 {
            let start = TimeInterval(minute * 60)
            try store.append([report(start: start, end: start)])
            try store.append([report(start: start, end: start + 31, bytesOut: 288)])
        }
        let rows = try store.observations()
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows.compactMap(\.bytesOut).reduce(0, +), 864)
    }

    func test一回の開始と終了は今までどおり一行にまとまる() throws {
        let store = try store()
        try store.append([report(start: 0, end: 0)])
        try store.append([report(start: 0, end: 30, bytesOut: 288)])
        let rows = try store.observations()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.bytesOut, 288)
        XCTAssertEqual(rows.first?.lastObservedAt, base.addingTimeInterval(30))
    }

    /// The extension restarted while the flow was open, so its closing report
    /// says it started when it closed. It still ends the open row.
    func test開始時刻の分からない終了報告は開いたままの行を完成させる() throws {
        let store = try store()
        try store.append([report(start: 0, end: 0)])
        try store.append([report(start: 600, end: 600, bytesOut: 288)])
        let rows = try store.observations()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.firstObservedAt, base)
        XCTAssertEqual(rows.first?.bytesOut, 288)
    }

    func test閉じた回の後の終了報告は閉じた行を書き換えない() throws {
        let store = try store()
        try store.append([report(start: 0, end: 0)])
        try store.append([report(start: 0, end: 30, bytesOut: 100)])
        try store.append([report(start: 600, end: 600, bytesOut: 288)])
        let rows = try store.observations().sorted { $0.firstObservedAt < $1.firstObservedAt }
        XCTAssertEqual(rows.map(\.bytesOut), [100, 288])
    }

    func test名前の後報告は同じ回の行に入る() throws {
        let store = try store()
        try store.append([report(start: 0, end: 0)])
        var named = report(start: 0, end: 5)
        named = ConnectionObservation(
            networkProtocol: named.networkProtocol, localAddress: named.localAddress,
            localPort: named.localPort, remoteAddress: named.remoteAddress,
            remotePort: named.remotePort, processID: named.processID,
            processName: named.processName, bundleID: nil,
            firstObservedAt: named.firstObservedAt, lastObservedAt: named.lastObservedAt,
            bytesIn: nil, bytesOut: nil, collector: .networkExtension, confidence: .exact,
            remoteHostname: "peer.example", flowID: flow
        )
        try store.append([named])
        let rows = try store.observations()
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?.remoteHostname, "peer.example")
    }

    func testv15の履歴は行を失わずに移行され以後は回ごとに分かれる() throws {
        let url = directory.appendingPathComponent("h.sqlite")
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([report(start: 0, end: 30, bytesOut: 100)])
            try store.append([report(start: 0, end: 0, flowID: UUID())])
        }
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        let downgrade = """
        DROP INDEX observations_flow_episode;
        ALTER TABLE observations DROP COLUMN flow_episode;
        CREATE UNIQUE INDEX observations_flow_id ON observations(flow_id) WHERE flow_id IS NOT NULL;
        PRAGMA user_version=15;
        """
        XCTAssertEqual(sqlite3_exec(database, downgrade, nil, nil, nil), SQLITE_OK)
        sqlite3_close(database)

        let reopened = try ObservationStore(fileURL: url)
        XCTAssertEqual(reopened.schemaVersion(), 16)
        XCTAssertEqual(try reopened.statistics().rawCount, 2)
        // The existing row is still the one its closing report completes.
        try reopened.append([report(start: 0, end: 40, bytesOut: 120)])
        XCTAssertEqual(try reopened.statistics().rawCount, 2)
        // A later time the flow opened is a row of its own.
        try reopened.append([report(start: 60, end: 90, bytesOut: 288)])
        XCTAssertEqual(try reopened.statistics().rawCount, 3)
    }
}

final class FlowEpisodeQueueTests: XCTestCase {
    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-episode-queue-\(UUID().uuidString).json")
    }

    func test開き直した回は送信待ちで前の回にまとめない() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([report(start: 0, end: 30, bytesOut: 288)])
        try queue.enqueue([report(start: 60, end: 60)])
        try queue.enqueue([report(start: 60, end: 90, bytesOut: 288)])
        XCTAssertEqual(queue.status().pendingCount, 2)
    }

    func test開始時刻の分からない終了報告は送信待ちの開始報告にまとまる() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([report(start: 0, end: 0)])
        try queue.enqueue([report(start: 600, end: 600, bytesOut: 288)])
        XCTAssertEqual(queue.status().pendingCount, 1)
    }

    func test間引きは開き直した回を落とさない() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = base
        XCTAssertEqual(sampler.observationsToPersist([report(start: 0, end: 30, bytesOut: 288)], observedAt: at).count, 1)
        XCTAssertEqual(
            sampler.observationsToPersist([report(start: 40, end: 40)], observedAt: at.addingTimeInterval(40)).count, 1,
            "the next time the flow opened is not a repeat of the last"
        )
    }
}
