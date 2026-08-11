import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentDeliveryQueueTests: XCTestCase {
    func testBatchIdentitySurvivesRestartUntilAcknowledged() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(remotePort: 443)], queuedAt: Date(timeIntervalSince1970: 10))

        let first = try XCTUnwrap(queue.prepareBatch(
            limit: 200,
            sentAt: Date(timeIntervalSince1970: 20),
            metadata: metadata()
        ))
        let restarted = try AgentDeliveryQueue(fileURL: url)
        let replay = try XCTUnwrap(restarted.prepareBatch(
            limit: 200,
            sentAt: Date(timeIntervalSince1970: 30),
            metadata: metadata()
        ))

        XCTAssertEqual(replay.batchId, first.batchId)
        XCTAssertEqual(replay.observations.map(\.observationId), first.observations.map(\.observationId))
        try restarted.acknowledge(batchID: replay.batchId, at: Date(timeIntervalSince1970: 40))
        XCTAssertEqual(restarted.status().pendingCount, 0)
        XCTAssertEqual(restarted.status().lastAcknowledgedAt, Date(timeIntervalSince1970: 40))
    }

    func testPendingFlowUpdatesAreCoalescedWithoutChangingObservationIdentity() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([observation(remotePort: 443, bytesOut: 10)])
        let first = try XCTUnwrap(queue.prepareBatch(limit: 1, sentAt: Date(), metadata: metadata()))
        try queue.acknowledge(batchID: first.batchId)

        try queue.enqueue([observation(remotePort: 8443, bytesOut: 10)])
        try queue.enqueue([observation(remotePort: 8443, bytesOut: 20)])
        let second = try XCTUnwrap(queue.prepareBatch(limit: 1, sentAt: Date(), metadata: metadata()))

        XCTAssertEqual(queue.status().pendingCount, 1)
        XCTAssertEqual(second.observations[0].bytesOut, "20")
    }

    func testQueueDropsOldestNonActiveRowsAtBound() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL(), maximumPending: 2)
        try queue.enqueue([
            observation(remotePort: 1),
            observation(remotePort: 2),
            observation(remotePort: 3),
        ])

        XCTAssertEqual(queue.status().pendingCount, 2)
        XCTAssertEqual(queue.status().droppedCount, 1)
    }

    func testQueueDropsObservationsThatCannotSatisfyTheHubContract() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([
            observation(remotePort: 443, localPort: 0),
            observation(remotePort: 0),
            observation(remotePort: 443),
        ])

        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        XCTAssertEqual(batch.observations.count, 1)
        XCTAssertEqual(batch.observations[0].localPort, 49_152)
        XCTAssertEqual(queue.status().droppedCount, 2)
    }

    func testRestartRemovesAnInvalidPersistedActiveBatch() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(remotePort: 443)])
        _ = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))

        var stored = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        var pending = try XCTUnwrap(stored["pending"] as? [[String: Any]])
        var first = pending[0]
        var invalidObservation = try XCTUnwrap(first["observation"] as? [String: Any])
        invalidObservation["localPort"] = 0
        first["observation"] = invalidObservation
        pending[0] = first
        stored["pending"] = pending
        try JSONSerialization.data(withJSONObject: stored).write(to: url, options: .atomic)

        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().pendingCount, 0)
        XCTAssertEqual(restarted.status().droppedCount, 1)
        XCTAssertNil(try restarted.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
    }

    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-agent-queue-\(UUID().uuidString).json")
    }

    private func metadata() -> AgentIngestMetadata {
        AgentIngestMetadata(
            hostName: "test-mac",
            platform: .macOS,
            osVersion: "26.5.2",
            agentVersion: "0.1.14"
        )
    }

    private func observation(
        remotePort: UInt16,
        localPort: UInt16 = 49_152,
        bytesOut: UInt64? = nil
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: localPort,
            remoteAddress: "203.0.113.10",
            remotePort: remotePort,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: Date(timeIntervalSince1970: 10),
            lastObservedAt: Date(timeIntervalSince1970: 11),
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact
        )
    }
}
