import EgressViewAgentCore
import EgressViewNetworkExtension
import XCTest

final class NetworkFlowObservationMapperTests: XCTestCase {
    func testMapsMetadataWithoutInventingByteCounts() {
        let observedAt = Date(timeIntervalSince1970: 200)
        let metadata = SocketFlowMetadata(
            networkProtocol: .udp,
            localAddress: "2001:db8::10",
            localPort: 51_000,
            remoteAddress: "2606:4700:4700::1111",
            remotePort: 443,
            processID: 42,
            processName: "browser",
            bundleID: "com.example.browser"
        )

        let observation = NetworkFlowObservationMapper().map(metadata, observedAt: observedAt)

        XCTAssertEqual(observation.networkProtocol, .udp)
        XCTAssertEqual(observation.remoteAddress, "2606:4700:4700::1111")
        XCTAssertEqual(observation.processID, 42)
        XCTAssertEqual(observation.bundleID, "com.example.browser")
        XCTAssertEqual(observation.collector, .networkExtension)
        XCTAssertEqual(observation.confidence, .exact)
        XCTAssertNil(observation.bytesIn)
        XCTAssertNil(observation.bytesOut)
        XCTAssertEqual(observation.firstObservedAt, observedAt)
        XCTAssertEqual(observation.lastObservedAt, observedAt)
    }
}
