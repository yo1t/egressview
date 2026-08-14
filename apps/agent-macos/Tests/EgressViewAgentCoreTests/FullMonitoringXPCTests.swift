import Foundation
import XCTest
@testable import EgressViewAgentCore

final class FullMonitoringXPCTests: XCTestCase {
    func testObservationRoundTripsAcrossXPCPayload() throws {
        let observation = ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 50_000,
            remoteAddress: "198.51.100.20",
            remotePort: 443,
            processID: 42,
            processName: "Example",
            firstObservedAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastObservedAt: Date(timeIntervalSince1970: 1_700_000_001),
            collector: .networkExtension,
            confidence: .exact
        )

        let payload = try FullMonitoringXPC.encoder().encode([observation])
        let decoded = try FullMonitoringXPC.decoder().decode([ConnectionObservation].self, from: payload)

        XCTAssertEqual(decoded, [observation])
    }

    func testMachServiceUsesTheAppGroupPrefixRequiredByNetworkExtension() {
        XCTAssertEqual(FullMonitoringXPC.machServiceName, "group.com.egressview.agent.xpc")
    }
}
