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
        XCTAssertEqual(queue.status().queueOverflowCount, 1)
        XCTAssertEqual(queue.status().contractRejectedCount, 0)
    }

    func testQueueDropsObservationsThatCannotSatisfyTheHubContract() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue([
            observation(remotePort: 443, localPort: 0),
            observation(remotePort: 0),
            observation(remotePort: 443),
        ])

        let batch = try XCTUnwrap(queue.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
        XCTAssertEqual(batch.observations.count, 2)
        XCTAssertEqual(Set(batch.observations.map(\.localPort)), Set([0, 49_152]))
        XCTAssertEqual(queue.status().contractRejectedCount, 1)
        XCTAssertEqual(queue.status().queueOverflowCount, 0)
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
        invalidObservation["remotePort"] = 0
        first["observation"] = invalidObservation
        pending[0] = first
        stored["pending"] = pending
        try JSONSerialization.data(withJSONObject: stored).write(to: url, options: .atomic)

        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().pendingCount, 0)
        XCTAssertEqual(restarted.status().droppedCount, 1)
        XCTAssertEqual(restarted.status().contractRejectedCount, 1)
        XCTAssertEqual(restarted.status().legacyUnclassifiedCount, 0)
        XCTAssertNil(try restarted.prepareBatch(limit: 200, sentAt: Date(), metadata: metadata()))
    }

    func testLegacyDroppedCountRemainsUnclassifiedAfterUpgrade() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(remotePort: 443)])
        var stored = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        stored["droppedCount"] = 224
        stored.removeValue(forKey: "contractRejectedCount")
        stored.removeValue(forKey: "queueOverflowCount")
        try JSONSerialization.data(withJSONObject: stored).write(to: url, options: .atomic)

        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().legacyUnclassifiedCount, 224)
        XCTAssertEqual(restarted.status().contractRejectedCount, 0)
        XCTAssertEqual(restarted.status().queueOverflowCount, 0)
        XCTAssertEqual(restarted.status().droppedCount, 224)
    }

    func testQueueWrittenBeforeReasonCountersIsPreserved() throws {
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(remotePort: 443)])
        var stored = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        )
        stored.removeValue(forKey: "contractRejectionReasons")
        try JSONSerialization.data(withJSONObject: stored).write(to: url, options: .atomic)

        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().pendingCount, 1)
        XCTAssertEqual(restarted.status().contractRejectionReasons, [:])
        XCTAssertNil(restarted.status().unreadableStateResetAt)
    }

    func testThePersistedQueueCanActuallyBeReadBack() throws {
        // The property that matters. A protection class that lets the write
        // succeed but the read fail loses every observation that had not
        // reached the Hub, and reports nothing.
        let url = temporaryURL()
        let queue = try AgentDeliveryQueue(fileURL: url)
        try queue.enqueue([observation(remotePort: 443)])

        XCTAssertNoThrow(try Data(contentsOf: url))
        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().pendingCount, 1)
        XCTAssertNil(restarted.status().unreadableStateResetAt)
    }

    func testAnUnreadableSavedQueueResetsAndIsReportedRatherThanStoppingTheAgent() throws {
        let url = temporaryURL()
        try Data("this is not the saved state".utf8).write(to: url)

        // Refusing to start would turn one lost buffer into an agent that
        // delivers nothing, and nobody would see an error.
        let queue = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(queue.status().pendingCount, 0)
        XCTAssertNotNil(queue.status().unreadableStateResetAt)

        // Collection continues, and the new state persists normally.
        try queue.enqueue([observation(remotePort: 443)])
        let restarted = try AgentDeliveryQueue(fileURL: url)
        XCTAssertEqual(restarted.status().pendingCount, 1)
        XCTAssertNil(restarted.status().unreadableStateResetAt)
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

extension AgentDeliveryQueueTests {
    /// The count said four and nothing said why.
    ///
    /// On 2026-08-24 `contractRejectedCount` had read 4 for days. The Hub had
    /// rejected none of the 408,491 observations it accepted, so those four
    /// were discarded here, on the Mac -- and the only way to find out what
    /// that meant was to read the function that discarded them.
    func testEachDiscardNamesTheRuleItFailed() throws {
        let cases: [(String, ConnectionObservation, AgentDeliveryQueue.ContractRejection)] = [
            ("port 0", rejectable(remotePort: 0), .remotePortZero),
            ("remote is not an address", rejectable(remoteAddress: "example.com"), .remoteAddressNotAnIP),
            ("local is not an address", rejectable(localAddress: ""), .localAddressNotAnIP),
            ("no process name", rejectable(processName: ""), .processNameUnusable),
        ]
        for (name, subject, expected) in cases {
            XCTAssertEqual(
                AgentDeliveryQueue.contractRejection(subject), expected,
                "\(name) was discarded without naming a rule"
            )
        }
    }

    func testADeliverableObservationNamesNoRule() throws {
        XCTAssertNil(AgentDeliveryQueue.contractRejection(rejectable()))
    }

    /// The reasons reach the report, not just the count.
    func testDiscardReasonsAreReadableFromTheQueueStatus() throws {
        let queue = try AgentDeliveryQueue(fileURL: temporaryURL())
        try queue.enqueue(
            [rejectable(remotePort: 0), rejectable(remotePort: 0), rejectable(processName: "")],
            queuedAt: Date(timeIntervalSince1970: 10)
        )
        let status = queue.status()
        XCTAssertEqual(status.contractRejectedCount, 3)
        XCTAssertEqual(
            status.contractRejectionReasons,
            ["remotePortZero": 2, "processNameUnusable": 1]
        )
    }

    private func rejectable(
        remotePort: UInt16 = 443,
        remoteAddress: String = "203.0.113.10",
        localAddress: String = "192.0.2.10",
        processName: String = "TestApp"
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: localAddress,
            localPort: 49_152,
            remoteAddress: remoteAddress,
            remotePort: remotePort,
            processID: 42,
            processName: processName,
            firstObservedAt: Date(timeIntervalSince1970: 10),
            lastObservedAt: Date(timeIntervalSince1970: 11),
            bytesOut: nil,
            collector: .networkExtension,
            confidence: .exact
        )
    }
}
