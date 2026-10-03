import EgressViewAgentCore
import EgressViewNetworkExtension
import XCTest

final class PacketFlowCorrelationTests: XCTestCase {
    private let flowID = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!

    private func flow(
        id: UUID? = nil,
        localAddress: String = "192.0.2.10",
        localPort: UInt16 = 50_000,
        processID: Int32 = 42
    ) -> CorrelatableFlow {
        CorrelatableFlow(
            id: id ?? flowID,
            metadata: SocketFlowMetadata(
                networkProtocol: .udp,
                localAddress: localAddress,
                localPort: localPort,
                remoteAddress: "198.51.100.20",
                remotePort: 443,
                processID: processID,
                processName: "test"
            )
        )
    }

    func testMatchesOutboundAndInboundOnlyWhenTupleIsUnique() {
        let outbound = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )
        let inbound = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "198.51.100.20", sourcePort: 443,
            destinationAddress: "192.0.2.10", destinationPort: 50_000
        )

        XCTAssertEqual(PacketFlowCorrelation.match(outbound, inbound: false, among: [flow()]), .unique(flowID))
        XCTAssertEqual(PacketFlowCorrelation.match(inbound, inbound: true, among: [flow()]), .unique(flowID))
        XCTAssertEqual(PacketFlowCorrelation.match(inbound, inbound: false, among: [flow()]), .none)
    }

    func testRejectsUnassignedLocalEndpointAndUnknownProcess() {
        let packet = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )

        XCTAssertEqual(PacketFlowCorrelation.match(packet, inbound: false, among: [flow(localPort: 0)]), .none)
        XCTAssertEqual(PacketFlowCorrelation.match(packet, inbound: false, among: [flow(localAddress: "0.0.0.0")]), .none)
        XCTAssertEqual(PacketFlowCorrelation.match(packet, inbound: false, among: [flow(processID: 0)]), .none)
    }

    func testDuplicateTupleIsAmbiguousEvenIfProcessNamesDiffer() {
        let packet = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )
        let second = flow(id: UUID(uuidString: "22222222-2222-2222-2222-222222222222"))

        XCTAssertEqual(PacketFlowCorrelation.match(packet, inbound: false, among: [flow(), second]), .ambiguous)
    }

    func testDifferentPortOrProtocolDoesNotMatch() {
        let wrongPort = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_001,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )
        let wrongProtocol = PacketTuple(
            networkProtocol: .tcp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )

        XCTAssertEqual(PacketFlowCorrelation.match(wrongPort, inbound: false, among: [flow()]), .none)
        XCTAssertEqual(PacketFlowCorrelation.match(wrongProtocol, inbound: false, among: [flow()]), .none)
    }

    func testIndexTracksOpenUpdateAndCloseWithoutGuessing() {
        let outbound = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        )
        let inbound = PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "198.51.100.20", sourcePort: 443,
            destinationAddress: "192.0.2.10", destinationPort: 50_000
        )
        let secondID = UUID(uuidString: "22222222-2222-2222-2222-222222222222")!
        var index = PacketFlowIndex()

        index.insert(flow(localPort: 0))
        XCTAssertEqual(index.match(outbound, inbound: false), .none)
        index.insert(flow())
        XCTAssertEqual(index.match(outbound, inbound: false), .unique(flowID))
        XCTAssertEqual(index.match(inbound, inbound: true), .unique(flowID))

        index.insert(flow(id: secondID))
        XCTAssertEqual(index.match(outbound, inbound: false), .ambiguous)
        index.remove(flowID: secondID)
        XCTAssertEqual(index.match(outbound, inbound: false), .unique(flowID))

        index.insert(flow(localPort: 50_001))
        XCTAssertEqual(index.match(outbound, inbound: false), .none)
        index.remove(flowID: flowID)
        XCTAssertEqual(index.match(outbound, inbound: false), .none)
    }
}
