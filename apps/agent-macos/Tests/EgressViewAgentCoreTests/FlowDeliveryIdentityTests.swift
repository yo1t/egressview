import Foundation
import XCTest
@testable import EgressViewAgentCore

/// Two connections from one process to one server share protocol, both
/// endpoints and PID often enough -- a local port is reused, or a client opens
/// several short connections -- and before P3-164 the second replaced the
/// first on the way to the Hub. The Network Extension gives every flow its own
/// UUID; delivery now keys on it.
final class FlowDeliveryIdentityTests: XCTestCase {
    private let first = UUID(uuidString: "00000000-0000-0000-0000-000000000001")!
    private let second = UUID(uuidString: "00000000-0000-0000-0000-000000000002")!

    func test_同じ組でもflowが違えば送信待ちに二件残る() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(flowID: first, bytesOut: 10)])
        try queue.enqueue([observation(flowID: second, bytesOut: 20)])

        XCTAssertEqual(queue.status().pendingCount, 2)
        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        XCTAssertEqual(Set(batch.observations.map(\.bytesOut)), ["10", "20"])
    }

    /// The opening carries the name, the closing report carries the bytes and
    /// usually no name. One flow, one pending item, and both facts kept.
    func test_同じflowの続報は一件にまとめ名前を消さない() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(flowID: first, hostname: "api.example")])
        try queue.enqueue([observation(flowID: first, bytesOut: 20, lastObservedAt: 30)])

        XCTAssertEqual(queue.status().pendingCount, 1)
        let batch = try XCTUnwrap(queue.prepareBatch(
            limit: 200, sentAt: Date(), metadata: metadata(), includeHostname: true
        ))
        XCTAssertEqual(batch.observations.count, 1)
        XCTAssertEqual(batch.observations[0].bytesOut, "20")
        XCTAssertEqual(batch.observations[0].remoteHostname, "api.example")
    }

    /// A batch in flight is exactly what was sent. A later report of a flow in
    /// it waits as its own item rather than changing what the Hub is being
    /// asked to acknowledge.
    func test_送信中のバッチは同じflowの続報で書き換えない() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(flowID: first, bytesOut: 10)])
        let sent = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))

        try queue.enqueue([observation(flowID: first, bytesOut: 99)])
        let replay = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))

        XCTAssertEqual(replay.batchId, sent.batchId)
        XCTAssertEqual(replay.observations.map(\.bytesOut), ["10"])
        XCTAssertEqual(queue.status().pendingCount, 2)
    }

    /// Observations without a flow -- the socket-table collector, and anything
    /// queued by a version that did not record one -- keep the old rule.
    func test_flowの無い観測は従来どおり組で置き換える() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(flowID: nil, bytesOut: 10)])
        try queue.enqueue([observation(flowID: nil, bytesOut: 20)])

        XCTAssertEqual(queue.status().pendingCount, 1)
        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        XCTAssertEqual(batch.observations[0].bytesOut, "20")
    }

    /// A queue file written before flows were recorded has no `flowID` key.
    /// It must still be read, not reset, and still deliver.
    func test_flowIDの無い古い送信待ちを読める() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(flowID: nil, bytesOut: 10)])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        var pending = try XCTUnwrap(json["pending"] as? [[String: Any]])
        var item = pending[0]
        var stored = try XCTUnwrap(item["observation"] as? [String: Any])
        stored.removeValue(forKey: "flowID")
        item["observation"] = stored
        pending[0] = item
        json["pending"] = pending
        try JSONSerialization.data(withJSONObject: json).write(to: url)

        let restarted = try AgentDeliveryQueue(fileURL: url)

        XCTAssertEqual(restarted.status().pendingCount, 1)
        XCTAssertNotNil(try restarted.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
    }

    /// The flow UUID keys the queue and goes nowhere else.
    func test_flowIDはHubへ送らない() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(flowID: first, hostname: "api.example")])
        let batch = try XCTUnwrap(queue.prepareBatch(
            limit: 200, sentAt: Date(), metadata: metadata(), includeHostname: true
        ))

        let body = String(decoding: try JSONEncoder().encode(batch), as: UTF8.self)

        XCTAssertFalse(body.contains(first.uuidString), "flow UUID が送信内容に含まれている")
        XCTAssertFalse(body.lowercased().contains(first.uuidString.lowercased()))
        XCTAssertFalse(body.contains("flowID"))
    }

    /// Before the queue there is a sampler that sends a still-open connection
    /// at most once a minute. Keyed by the tuple, a second flow within that
    /// minute was taken for a repeat of the first and never queued.
    func test_送信前の間引きも別のflowを同じものとみなさない() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = Date(timeIntervalSince1970: 100)

        XCTAssertEqual(sampler.observationsToPersist([observation(flowID: first)], observedAt: at).count, 1)
        XCTAssertEqual(
            sampler.observationsToPersist(
                [observation(flowID: second)], observedAt: at.addingTimeInterval(5)
            ).count, 1,
            "同じ組の別flowが間引かれた"
        )
    }

    func test_送信前の間引きは同じflowの繰り返しを従来どおり間引く() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = Date(timeIntervalSince1970: 100)

        _ = sampler.observationsToPersist([observation(flowID: first)], observedAt: at)

        XCTAssertTrue(sampler.observationsToPersist(
            [observation(flowID: first)], observedAt: at.addingTimeInterval(5)
        ).isEmpty)
    }

    /// The closing report is the only one with byte counts, and it arrives
    /// within a second of the opening one. Taken for a repeat, it never reached
    /// the Hub: after 0.5.87 the production Hub had byte counts for 15% of this
    /// Mac's rows where it had 50% before.
    func test_送信前の間引きは終了時の報告を捨てない() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = Date(timeIntervalSince1970: 100)

        let opening = sampler.observationsToPersist([observation(flowID: first)], observedAt: at)
        let closing = sampler.observationsToPersist(
            [observation(flowID: first, bytesOut: 700)], observedAt: at.addingTimeInterval(0.5)
        )

        XCTAssertEqual(opening.count, 1)
        XCTAssertEqual(closing.count, 1, "終了時の報告（バイト数あり）が間引かれた")
        XCTAssertEqual(closing.first?.bytesOut, 700)
    }

    /// Only the first report with counts is new information. A second one for
    /// the same flow inside the interval is still a repeat.
    func test_送信前の間引きはバイト数のある報告の繰り返しは間引く() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = Date(timeIntervalSince1970: 100)

        _ = sampler.observationsToPersist([observation(flowID: first, bytesOut: 700)], observedAt: at)

        XCTAssertTrue(sampler.observationsToPersist(
            [observation(flowID: first, bytesOut: 900)], observedAt: at.addingTimeInterval(5)
        ).isEmpty)
    }

    /// Opening and closing in the same batch, which is how a short flow often
    /// arrives from the extension.
    func test_同じバッチの開始と終了の報告は両方残す() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let at = Date(timeIntervalSince1970: 100)

        let both = sampler.observationsToPersist(
            [observation(flowID: first), observation(flowID: first, bytesOut: 700)], observedAt: at
        )

        XCTAssertEqual(both.map(\.bytesOut), [nil, 700])
    }

    /// Through the whole path: the closing report reaches the queue and
    /// completes the pending opening report, so one row goes to the Hub with
    /// its byte counts and the name from the opening.
    func test_終了時の報告が送信待ちの開始の報告にバイト数を足す() throws {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        let at = Date(timeIntervalSince1970: 100)

        try queue.enqueue(sampler.observationsToPersist([observation(flowID: first, hostname: "api.example")], observedAt: at))
        try queue.enqueue(sampler.observationsToPersist(
            [observation(flowID: first, bytesOut: 700)], observedAt: at.addingTimeInterval(0.5)
        ))

        XCTAssertEqual(queue.status().pendingCount, 1)
        let batch = try XCTUnwrap(queue.prepareBatch(
            limit: 200, sentAt: Date(), metadata: metadata(), includeHostname: true
        ))
        XCTAssertEqual(batch.observations[0].bytesOut, "700")
        XCTAssertEqual(batch.observations[0].remoteHostname, "api.example")
    }

    func test_送信の識別はflowがあればflow無ければ組() {
        let withFlow = observation(flowID: first)
        let withoutFlow = observation(flowID: nil)

        XCTAssertNotEqual(withFlow.deliveryIdentity, observation(flowID: second).deliveryIdentity)
        XCTAssertEqual(withoutFlow.deliveryIdentity, withoutFlow.stableKey)
        XCTAssertEqual(withFlow.stableKey, observation(flowID: second).stableKey)
    }

    private func observation(
        flowID: UUID?,
        bytesOut: UInt64? = nil,
        hostname: String? = nil,
        lastObservedAt: TimeInterval = 11
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: "203.0.113.10",
            remotePort: 443,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: Date(timeIntervalSince1970: 10),
            lastObservedAt: Date(timeIntervalSince1970: lastObservedAt),
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: hostname,
            flowID: flowID
        )
    }

    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-flow-identity-\(UUID().uuidString).json")
    }

    private func metadata() -> AgentIngestMetadata {
        AgentIngestMetadata(hostName: "test-mac", platform: .macOS, osVersion: "26.5.2", agentVersion: "0.5.87")
    }
}
