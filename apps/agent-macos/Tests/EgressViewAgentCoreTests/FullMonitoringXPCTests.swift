import Foundation
import XCTest
@testable import EgressViewAgentCore

final class FullMonitoringXPCTests: XCTestCase {
    func testObservationRoundTripsAcrossXPCPayload() throws {
        let flowID = UUID()
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
            confidence: .exact,
            flowID: flowID
        )

        let payload = try FullMonitoringXPC.encoder().encode([observation])
        let decoded = try FullMonitoringXPC.decoder().decode([ConnectionObservation].self, from: payload)

        XCTAssertEqual(decoded, [observation])
        XCTAssertEqual(decoded.first?.flowID, flowID)
    }

    /// The name must start with the App Group and end in a build number.
    ///
    /// macOS validates NetworkExtension Mach service names against the
    /// extension's `com.apple.security.application-groups`, so the prefix is
    /// not cosmetic. The build-specific suffix is what stopped an old
    /// extension holding the name while the new one got `Operation not
    /// permitted` on update (P3-20 Phase 2, 2026-08-28).
    ///
    /// The number itself is checked against Info.plist by
    /// `test/unit/agent-macos-sandbox.test.js` and by `build-release.sh`,
    /// which read the plists. Repeating the literal here checked nothing those
    /// do not, and had to be edited on every build.
    func testMachServiceUsesTheAppGroupPrefixAndABuildSuffix() {
        let name = FullMonitoringXPC.machServiceName
        XCTAssertTrue(
            name.hasPrefix("group.com.egressview.agent.xpc."),
            "\(name) is not inside the App Group macOS validates against"
        )
        let suffix = name.dropFirst("group.com.egressview.agent.xpc.".count)
        XCTAssertFalse(suffix.isEmpty, "the name carries no build number")
        XCTAssertTrue(
            suffix.allSatisfy(\.isNumber),
            "\(suffix) is not a build number, so two builds could share the name"
        )
    }
}
