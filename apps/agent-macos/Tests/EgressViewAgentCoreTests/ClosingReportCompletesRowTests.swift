import Foundation
import XCTest
@testable import EgressViewAgentCore

/// A flow's closing report goes to the Hub under the id of its opening report
/// when the Hub has said it completes such a row, so one connection is one row
/// with its byte counts (P3-170).
final class ClosingReportCompletesRowTests: XCTestCase {
    private let flow = UUID(uuidString: "00000000-0000-0000-0000-00000000f10e")!

    private func observation(bytes: UInt64?) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: bytes == nil ? 0 : 50_000,
            remoteAddress: "203.0.113.10", remotePort: 443, processID: 42, processName: "TestApp",
            firstObservedAt: Date(timeIntervalSince1970: 10), lastObservedAt: Date(timeIntervalSince1970: bytes == nil ? 10 : 12),
            bytesIn: bytes, bytesOut: bytes, collector: .networkExtension, confidence: .exact,
            flowID: flow
        )
    }

    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("egressview-complete-\(UUID().uuidString).json")
    }

    private func metadata() -> AgentIngestMetadata {
        AgentIngestMetadata(hostName: "test-mac", platform: .macOS, osVersion: "27.0", agentVersion: "0.5.90")
    }

    /// Sends and acknowledges whatever is pending; returns the ids sent.
    @discardableResult
    private func deliver(_ queue: AgentDeliveryQueue) throws -> [UUID] {
        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        try queue.acknowledge(batchID: batch.batchId)
        return batch.observations.map(\.observationId)
    }

    func test_Hubが行を完成させるなら終了時の報告は開始時と同じidで送る() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        queue.setHubCompletesObservations(true)
        try queue.enqueue([observation(bytes: nil)])
        let opening = try deliver(queue)

        try queue.enqueue([observation(bytes: 700)])
        let closing = try deliver(queue)

        XCTAssertEqual(closing, opening)
    }

    /// An older Hub would count the second report as a duplicate and the
    /// counts would be lost. It gets its own row, as up to 0.5.89.
    func test_Hubが行を完成させないなら終了時の報告は別のidで送る() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        queue.setHubCompletesObservations(false)
        try queue.enqueue([observation(bytes: nil)])
        let opening = try deliver(queue)

        try queue.enqueue([observation(bytes: 700)])
        let closing = try deliver(queue)

        XCTAssertNotEqual(closing, opening)
    }

    func test_開始時のidは一度しか使わない() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        queue.setHubCompletesObservations(true)
        try queue.enqueue([observation(bytes: nil)])
        let opening = try deliver(queue)

        try queue.enqueue([observation(bytes: 700)])
        _ = try deliver(queue)
        try queue.enqueue([observation(bytes: 900)])
        let again = try deliver(queue)

        XCTAssertNotEqual(again, opening)
    }

    /// Not yet sent: the queue merges the two reports into one pending entry
    /// (#655), which is already one row with its counts.
    func test_開始時の報告が送信待ちなら一件にまとめる() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        queue.setHubCompletesObservations(true)
        try queue.enqueue([observation(bytes: nil)])
        try queue.enqueue([observation(bytes: 700)])

        XCTAssertEqual(queue.status().pendingCount, 1)
        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        XCTAssertEqual(batch.observations.first?.bytesOut, "700")
    }

    /// The agent may restart between a flow's opening and its closing.
    func test_再起動をまたいでも開始時のidを覚えている() throws {
        let url = temporaryURL()
        let before = try AgentDeliveryQueue(fileURL: url)
        before.setHubCompletesObservations(true)
        try before.enqueue([observation(bytes: nil)])
        let opening = try deliver(before)

        let after = try AgentDeliveryQueue(fileURL: url)
        after.setHubCompletesObservations(true)
        try after.enqueue([observation(bytes: 700)])

        XCTAssertEqual(try deliver(after), opening)
    }

    func test_覚えておく数には上限がある() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url, sentOpeningLimit: 3)
        queue.setHubCompletesObservations(true)
        let flows = (0...3).map { _ in UUID() }
        for id in flows {
            try queue.enqueue([ConnectionObservation(
                networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 0,
                remoteAddress: "203.0.113.10", remotePort: 443, processID: 42, processName: "TestApp",
                firstObservedAt: Date(timeIntervalSince1970: 10), lastObservedAt: Date(timeIntervalSince1970: 10),
                collector: .networkExtension, confidence: .exact, flowID: id
            )])
        }
        var openingIDs: Set<UUID> = []
        while queue.status().pendingCount > 0 { openingIDs.formUnion(try deliver(queue)) }

        // The oldest opening was forgotten; its closing report gets its own row.
        let oldest = flows[0]
        try queue.enqueue([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 50_000,
            remoteAddress: "203.0.113.10", remotePort: 443, processID: 42, processName: "TestApp",
            firstObservedAt: Date(timeIntervalSince1970: 10), lastObservedAt: Date(timeIntervalSince1970: 12),
            bytesIn: 1, bytesOut: 1, collector: .networkExtension, confidence: .exact, flowID: oldest
        )])
        let sent = try deliver(queue)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual((json["sentOpenings"] as? [Any])?.count, 3)
        XCTAssertEqual(sent.count, 1)
        // A new id: the oldest opening was forgotten, so this is its own row.
        XCTAssertFalse(openingIDs.contains(sent[0]))
    }

    func test_覚えたidのない古い送信待ちファイルも読める() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(bytes: nil)])
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        json.removeValue(forKey: "sentOpenings")
        try JSONSerialization.data(withJSONObject: json).write(to: url)

        let reopened = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(reopened.status().pendingCount, 1)
    }

    func test_Hubの回答を読む() throws {
        let decode = { (json: String) in
            try JSONDecoder().decode(AgentHubCapabilities.self, from: Data(json.utf8))
        }
        XCTAssertTrue(AgentCapabilityNegotiation.completesObservations(
            capabilities: try decode(#"{"schemaVersions":[1],"observationUpdates":true}"#)))
        XCTAssertFalse(AgentCapabilityNegotiation.completesObservations(
            capabilities: try decode(#"{"schemaVersions":[1]}"#)))
        XCTAssertFalse(AgentCapabilityNegotiation.completesObservations(capabilities: nil))
    }
}

private final class CompletingHubStore: AgentCredentialStoring, @unchecked Sendable {
    let credential = AgentCredential(
        hubURL: URL(string: "https://hub.example")!, agentID: UUID(), token: "egva_" + String(repeating: "a", count: 64)
    )
    func save(_ credential: AgentCredential) {}
    func load() -> AgentCredential? { credential }
    func delete() {}
}

/// A Hub whose capability answer is set by the test; records the ids it was sent.
private actor RecordingHub: AgentIngestTransport {
    let completes: Bool
    private(set) var sentIDs: [[String]] = []
    init(completes: Bool) { self.completes = completes }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let ok = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
        if url.path.hasSuffix("capabilities") {
            let body = completes
                ? #"{"schemaVersions":[1],"maxObservationsPerBatch":200,"observationUpdates":true}"#
                : #"{"schemaVersions":[1],"maxObservationsPerBatch":200}"#
            return (Data(body.utf8), ok)
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        let observations = json["observations"] as? [[String: Any]] ?? []
        sentIDs.append(observations.compactMap { $0["observationId"] as? String })
        let ack = #"{"batchId":"\#(json["batchId"] as? String ?? "")","accepted":0,"duplicate":\#(observations.count),"rejected":0,"replayed":false}"#
        return (Data(ack.utf8), ok)
    }
}

extension ClosingReportCompletesRowTests {
    private func run(completes: Bool) async throws -> [[String]] {
        let hub = RecordingHub(completes: completes)
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        let sender = AgentIngestSender(
            queue: queue, credentialStore: CompletingHubStore(), transport: hub,
            metadata: metadata(), retryPolicy: AgentRetryPolicy(initialDelay: 0.01, maximumDelay: 0.05)
        )
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        await sender.enqueue([observation(bytes: nil)])
        for _ in 0..<100 where queue.status().pendingCount > 0 { try await Task.sleep(for: .milliseconds(20)) }
        await sender.enqueue([observation(bytes: 700)])
        for _ in 0..<100 where queue.status().pendingCount > 0 { try await Task.sleep(for: .milliseconds(20)) }
        return await hub.sentIDs
    }

    func test_Hubの回答に従って終了時の報告のidを決める() async throws {
        let told = try await run(completes: true)
        XCTAssertEqual(told.count, 2)
        XCTAssertEqual(told[0], told[1], "Hubが行を完成させると言ったのに、終了時の報告を別のidで送った")

        let notTold = try await run(completes: false)
        XCTAssertEqual(notTold.count, 2)
        XCTAssertNotEqual(notTold[0], notTold[1], "言っていないHubに同じidを再送した")
    }
}
