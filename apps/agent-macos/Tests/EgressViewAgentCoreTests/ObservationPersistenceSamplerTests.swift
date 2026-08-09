import EgressViewAgentCore
import Foundation
import XCTest

final class ObservationPersistenceSamplerTests: XCTestCase {
    func testPersistsNewFlowImmediatelyAndThrottlesActiveFlow() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let observation = makeObservation(at: Date(timeIntervalSince1970: 100))

        XCTAssertEqual(sampler.observationsToPersist([observation], observedAt: observation.lastObservedAt).count, 1)
        XCTAssertTrue(sampler.observationsToPersist(
            [observation],
            observedAt: Date(timeIntervalSince1970: 120)
        ).isEmpty)
        XCTAssertEqual(sampler.observationsToPersist(
            [observation],
            observedAt: Date(timeIntervalSince1970: 160)
        ).count, 1)
    }

    func testReappearingFlowIsPersistedImmediately() {
        var sampler = ObservationPersistenceSampler(refreshInterval: 60)
        let observation = makeObservation(at: Date(timeIntervalSince1970: 100))

        _ = sampler.observationsToPersist([observation], observedAt: observation.lastObservedAt)
        _ = sampler.observationsToPersist([], observedAt: Date(timeIntervalSince1970: 110))

        XCTAssertEqual(sampler.observationsToPersist(
            [observation],
            observedAt: Date(timeIntervalSince1970: 120)
        ).count, 1)
    }

    private func makeObservation(at date: Date) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: "203.0.113.10",
            remotePort: 443,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: date,
            lastObservedAt: date,
            collector: .libproc,
            confidence: .sampled
        )
    }
}
