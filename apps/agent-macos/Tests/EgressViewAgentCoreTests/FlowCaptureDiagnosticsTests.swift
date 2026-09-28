import EgressViewAgentCore
import Foundation
import XCTest

final class FlowCaptureDiagnosticsTests: XCTestCase {
    func testPipelineCountersEncodeWithoutFlowIdentity() throws {
        var counters = FlowCaptureDiagnostics(startedAt: Date(timeIntervalSince1970: 1))
        counters.record(.newFlow)
        counters.record(.missingLocalEndpoint)
        counters.record(.registeredFlow)
        counters.record(.closedReport)
        counters.record(.unregisteredCloseRecovered)
        counters.record(.unregisteredCloseUnresolved)
        counters.record(.emittedObservation)
        counters.record(.enqueuedObservation)
        counters.record(.droppedObservation)
        counters.recordDrained(2)

        let data = try FullMonitoringXPC.encoder().encode(counters)
        let restored = try FullMonitoringXPC.decoder().decode(FlowCaptureDiagnostics.self, from: data)
        XCTAssertEqual(restored, counters)
        XCTAssertEqual(restored.newFlows, 1)
        XCTAssertEqual(restored.missingLocalEndpoints, 1)
        XCTAssertEqual(restored.unregisteredClosesRecovered, 1)
        XCTAssertEqual(restored.unregisteredClosesUnresolved, 1)
        XCTAssertEqual(restored.drainedObservations, 2)
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("remoteAddress"))
        XCTAssertFalse(String(decoding: data, as: UTF8.self).contains("processName"))
    }

    func testHostCountsDistinguishReceiptFromPersistence() {
        var counters = FlowPersistenceDiagnostics()
        counters.recordReceived(3, completedWithoutBytes: 1)
        counters.recordFailure()
        XCTAssertEqual(counters.receivedObservations, 3)
        XCTAssertEqual(counters.persistedObservations, 0)
        XCTAssertEqual(counters.failedBatches, 1)
        XCTAssertEqual(counters.completedWithoutBytes, 1)
        counters.recordPersisted(3)
        XCTAssertEqual(counters.persistedObservations, 3)
        counters.recordDrainTimeout()
        counters.recordXPCFailure()
        XCTAssertEqual(counters.drainTimeouts, 1)
        XCTAssertEqual(counters.xpcFailures, 1)
    }
}
