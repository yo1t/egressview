import Foundation
import XCTest
@testable import EgressViewAgentCore

// Recent, so the queue does not drop the observations as older than the Hub
// keeps, and with a fraction finer than a millisecond, as `Date()` has.
private let fractionalEpoch = Date(
    timeIntervalSince1970: (Date().timeIntervalSince1970 - 3_600).rounded(.down) + 0.123_456_7
)

/// The delivery queue keeps the fraction of a second across a restart.
/// `.iso8601` dropped it, so a flow open across an agent restart lost the link
/// between its opening and closing reports and became two rows at the Hub.
final class AgentDeliveryQueueTimestampTests: XCTestCase {
    private let flow = UUID(uuidString: "00000000-0000-0000-0000-0000000f4ac7")!

    private func observation(bytes: UInt64?, at epoch: Date = fractionalEpoch) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 50_000,
            remoteAddress: "203.0.113.10", remotePort: 443, processID: 42, processName: "TestApp",
            firstObservedAt: epoch.addingTimeInterval(10),
            lastObservedAt: epoch.addingTimeInterval(bytes == nil ? 10.5 : 12.75),
            bytesIn: bytes, bytesOut: bytes, collector: .networkExtension, confidence: .exact,
            flowID: flow
        )
    }

    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-timestamp-\(UUID().uuidString).json")
    }

    private func reopen(_ url: URL) throws -> AgentDeliveryQueue {
        let queue = try AgentDeliveryQueue(fileURL: url)
        queue.setHubCompletesObservations(true)
        return queue
    }

    @discardableResult
    private func deliver(_ queue: AgentDeliveryQueue) throws -> [UUID] {
        let batch = try XCTUnwrap(queue.prepareBatch(
            limit: 200, sentAt: Date(),
            metadata: AgentIngestMetadata(hostName: "test-mac", platform: .macOS, osVersion: "27.0", agentVersion: "0.5.90")
        ))
        try queue.acknowledge(batchID: batch.batchId)
        return batch.observations.map(\.observationId)
    }

    func test_小数秒の時刻でも再起動をまたいで開始時のidを使う() throws {
        let url = temporaryURL()
        let before = try reopen(url)
        try before.enqueue([observation(bytes: nil)])
        let opening = try deliver(before)

        let after = try reopen(url)
        try after.enqueue([observation(bytes: 700)])

        XCTAssertEqual(try deliver(after), opening)
    }

    func test_小数秒の時刻でも再起動をまたいで送信待ちの報告とまとまる() throws {
        let url = temporaryURL()
        try reopen(url).enqueue([observation(bytes: nil)])

        let after = try reopen(url)
        try after.enqueue([observation(bytes: 700)])

        XCTAssertEqual(after.status().pendingCount, 1)
    }

    /// Agents before this wrote whole seconds. Their queue must still load and
    /// still complete the rows it remembers.
    func test_秒単位で書かれた古い送信待ちファイルも読める() throws {
        let wholeSecondEpoch = Date(timeIntervalSince1970: fractionalEpoch.timeIntervalSince1970.rounded(.down))
        let url = temporaryURL()
        let before = try reopen(url)
        try before.enqueue([observation(bytes: nil, at: wholeSecondEpoch)])
        let opening = try deliver(before)
        try before.enqueue([observation(bytes: nil, at: wholeSecondEpoch.addingTimeInterval(100))])

        // Rewrite every time the way `.iso8601` did.
        let written = try String(contentsOf: url, encoding: .utf8)
        let legacy = written.replacingOccurrences(
            of: #"(T\d{2}:\d{2}:\d{2})\.\d{3}Z"#, with: "$1Z", options: .regularExpression
        )
        XCTAssertNotEqual(legacy, written)
        XCTAssertFalse(legacy.contains(".000Z"))
        try legacy.write(to: url, atomically: true, encoding: .utf8)

        let after = try reopen(url)
        XCTAssertNil(after.status().unreadableStateResetAt)
        XCTAssertEqual(after.status().pendingCount, 1)
        try after.enqueue([observation(bytes: 700, at: wholeSecondEpoch)])
        XCTAssertTrue(try deliver(after).contains(opening[0]))
    }

    func test_時刻はミリ秒まで書いて同じミリ秒で読み戻す() throws {
        XCTAssertEqual(
            QueueTimestamp.string(from: Date(timeIntervalSince1970: 1_763_427_723.25)),
            "2025-11-18T01:02:03.250Z"
        )
        XCTAssertEqual(QueueTimestamp.string(from: Date(timeIntervalSince1970: 0)), "1970-01-01T00:00:00.000Z")
        XCTAssertEqual(QueueTimestamp.string(from: Date(timeIntervalSince1970: -0.25)), "1969-12-31T23:59:59.750Z")

        for seconds in [0, 10.25, 10.0006, 10.9999, -0.25, 1_763_427_723.123_456_7] {
            let date = Date(timeIntervalSince1970: seconds)
            let read = try XCTUnwrap(QueueTimestamp.date(from: QueueTimestamp.string(from: date)))
            XCTAssertEqual(QueueTimestamp.milliseconds(read), QueueTimestamp.milliseconds(date), "\(seconds)")
        }
    }

    func test_秒単位や桁数の違う時刻も読む() throws {
        // `Date` counts from 2001, so compare milliseconds rather than doubles.
        let read = { QueueTimestamp.date(from: $0).map(QueueTimestamp.milliseconds) }
        XCTAssertEqual(read("1970-01-01T00:00:10Z"), 10_000)
        XCTAssertEqual(read("1970-01-01T00:00:10.5Z"), 10_500)
        XCTAssertEqual(read("1970-01-01T00:00:10.123456Z"), 10_123)
        XCTAssertNil(QueueTimestamp.date(from: "1970-01-01T00:00:10.Z"))
        XCTAssertNil(QueueTimestamp.date(from: "not a date"))
    }
}
