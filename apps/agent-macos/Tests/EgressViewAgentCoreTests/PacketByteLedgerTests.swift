import EgressViewAgentCore
import EgressViewNetworkExtension
import Foundation
import XCTest

final class PacketByteLedgerTests: XCTestCase {
    /// An IPv4 UDP packet from `source` to `destination` with `payload` bytes after the headers.
    private func ipv4UDP(
        source: [UInt8], sourcePort: UInt16, destination: [UInt8], destinationPort: UInt16, payload: Int
    ) -> [UInt8] {
        let total = 20 + 8 + payload
        var bytes: [UInt8] = [
            0x45, 0, UInt8(total >> 8), UInt8(total & 0xff), 0, 0, 0, 0, 64, 17, 0, 0,
        ]
        bytes += source + destination
        bytes += [
            UInt8(sourcePort >> 8), UInt8(sourcePort & 0xff),
            UInt8(destinationPort >> 8), UInt8(destinationPort & 0xff),
            UInt8((8 + payload) >> 8), UInt8((8 + payload) & 0xff), 0, 0,
        ]
        return bytes + [UInt8](repeating: 0xab, count: payload)
    }

    /// An IPv4 TCP packet with a 32-byte TCP header (options) and `payload` bytes.
    private func ipv4TCP(
        source: [UInt8], sourcePort: UInt16, destination: [UInt8], destinationPort: UInt16, payload: Int
    ) -> [UInt8] {
        let total = 20 + 32 + payload
        var bytes: [UInt8] = [
            0x45, 0, UInt8(total >> 8), UInt8(total & 0xff), 0, 0, 0, 0, 64, 6, 0, 0,
        ]
        bytes += source + destination
        var tcp = [UInt8](repeating: 0, count: 32)
        tcp[0] = UInt8(sourcePort >> 8); tcp[1] = UInt8(sourcePort & 0xff)
        tcp[2] = UInt8(destinationPort >> 8); tcp[3] = UInt8(destinationPort & 0xff)
        tcp[12] = 0x80
        return bytes + tcp + [UInt8](repeating: 0xcd, count: payload)
    }

    private func record(_ ledger: PacketByteLedger, _ packet: [UInt8], outbound: Bool, prefix: Int = 128) {
        packet.withUnsafeBytes { raw in
            ledger.record(
                UnsafeRawBufferPointer(rebasing: raw.prefix(min(prefix, raw.count))),
                packetLength: packet.count,
                outbound: outbound
            )
        }
    }

    private func flow(
        _ networkProtocol: InternetProtocol = .udp,
        local: String = "192.0.2.10", localPort: UInt16 = 50_000,
        remote: String = "198.51.100.20", remotePort: UInt16 = 443
    ) -> SocketFlowMetadata {
        SocketFlowMetadata(
            networkProtocol: networkProtocol,
            localAddress: local, localPort: localPort,
            remoteAddress: remote, remotePort: remotePort,
            processID: 42, processName: "test"
        )
    }

    private let mac: [UInt8] = [192, 0, 2, 10]
    private let server: [UInt8] = [198, 51, 100, 20]

    func testCountsBothDirectionsOfOneTupleAsOneFlowByPayload() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 1_200), outbound: true)
        record(ledger, ipv4UDP(source: server, sourcePort: 443, destination: mac, destinationPort: 50_000, payload: 1_350), outbound: false)
        record(ledger, ipv4UDP(source: server, sourcePort: 443, destination: mac, destinationPort: 50_000, payload: 1_350), outbound: false)

        XCTAssertEqual(ledger.take(flow()), PacketByteLedger.Counts(
            inboundBytes: 2_700, outboundBytes: 1_200, inboundPackets: 2, outboundPackets: 1
        ), "headers are not counted, only what the flow carried")
    }

    func testTCPPayloadExcludesItsOptions() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4TCP(source: mac, sourcePort: 51_000, destination: server, destinationPort: 443, payload: 0), outbound: true)
        record(ledger, ipv4TCP(source: server, sourcePort: 443, destination: mac, destinationPort: 51_000, payload: 1_000), outbound: false)
        let counts = ledger.take(flow(.tcp, localPort: 51_000))
        XCTAssertEqual(counts?.inboundBytes, 1_000)
        XCTAssertEqual(counts?.outboundBytes, 0)
        XCTAssertEqual(counts?.outboundPackets, 1, "an empty segment is still counted as a packet")
    }

    func testAClosedFlowTakesItsCountsSoTheNextFlowOnTheTupleStartsAtZero() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 500), outbound: true)
        XCTAssertNotNil(ledger.take(flow()))
        XCTAssertNil(ledger.take(flow()), "nothing left for a second close")
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 70), outbound: true)
        XCTAssertEqual(ledger.take(flow())?.outboundBytes, 70)
    }

    func testOtherTuplesAreNotMixedIn() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 100), outbound: true)
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_001, destination: server, destinationPort: 443, payload: 900), outbound: true)
        record(ledger, ipv4TCP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 900), outbound: true)
        XCTAssertEqual(ledger.take(flow())?.outboundBytes, 100)
    }

    func testAddressesAreComparedTheWayBothSidesWriteThem() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 64), outbound: true)
        // A dual-stack socket reports the IPv4 peer as an IPv4-mapped address.
        XCTAssertEqual(ledger.take(flow(local: "::ffff:192.0.2.10", remote: "::FFFF:198.51.100.20"))?.outboundBytes, 64)
    }

    func testAFlowWithoutALocalEndpointClaimsNothing() {
        let ledger = PacketByteLedger()
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 64), outbound: true)
        XCTAssertNil(ledger.take(flow(local: "", localPort: 0)))
        XCTAssertEqual(ledger.take(flow())?.outboundBytes, 64, "the entry is still there for the right claimant")
    }

    func testUnreadablePacketsAreCountedButNeverAttributed() {
        let ledger = PacketByteLedger()
        record(ledger, [0x45, 0, 0], outbound: true)
        record(ledger, [0x00] + [UInt8](repeating: 0, count: 40), outbound: false)
        let stats = ledger.snapshot()
        XCTAssertEqual(stats.packets, 2)
        XCTAssertEqual(stats.unreadable, 2)
        XCTAssertEqual(stats.entries, 0)
    }

    func testAHeaderOnlyPrefixIsEnough() {
        let ledger = PacketByteLedger()
        let packet = ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 1_400)
        record(ledger, packet, outbound: true, prefix: 28)
        XCTAssertEqual(ledger.take(flow())?.outboundBytes, 1_400, "length comes from the header, not the prefix")
    }

    func testIdleEntriesAndTheOldestBeyondCapacityAreDropped() {
        var clock: TimeInterval = 0
        let ledger = PacketByteLedger(capacity: 2, idleSeconds: 60, now: { clock })
        for port: UInt16 in [50_000, 50_001, 50_002] {
            record(ledger, ipv4UDP(source: mac, sourcePort: port, destination: server, destinationPort: 443, payload: 10), outbound: true)
            clock += 1
        }
        XCTAssertNil(ledger.take(flow(localPort: 50_000)), "the oldest went first")
        XCTAssertNotNil(ledger.take(flow(localPort: 50_002)))
        clock += 120
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_003, destination: server, destinationPort: 443, payload: 10), outbound: true)
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_004, destination: server, destinationPort: 443, payload: 10), outbound: true)
        record(ledger, ipv4UDP(source: mac, sourcePort: 50_005, destination: server, destinationPort: 443, payload: 10), outbound: true)
        XCTAssertNil(ledger.take(flow(localPort: 50_001)), "idle for two minutes")
        XCTAssertGreaterThan(ledger.snapshot().evicted, 0)
    }

    /// The packet filter delivers Ethernet frames on en0: 14 bytes of link
    /// layer before the IP header. Build 190 read none of 360,347 of them.
    private func ethernet(_ ip: [UInt8], etherType: UInt16, vlan: Bool = false) -> [UInt8] {
        var frame: [UInt8] = [0x02, 0, 0, 0, 0, 1, 0x02, 0, 0, 0, 0, 2]
        if vlan { frame += [0x81, 0x00, 0x00, 0x05] }
        frame += [UInt8(etherType >> 8), UInt8(etherType & 0xff)]
        return frame + ip
    }

    func testReadsPacketsBehindAnEthernetHeader() {
        let ledger = PacketByteLedger()
        let out = ipv4UDP(source: mac, sourcePort: 50_000, destination: server, destinationPort: 443, payload: 1_200)
        let back = ipv4UDP(source: server, sourcePort: 443, destination: mac, destinationPort: 50_000, payload: 1_350)
        record(ledger, ethernet(out, etherType: 0x0800), outbound: true)
        record(ledger, ethernet(back, etherType: 0x0800, vlan: true), outbound: false)
        record(ledger, back, outbound: false)
        XCTAssertEqual(ledger.take(flow()), PacketByteLedger.Counts(
            inboundBytes: 2_700, outboundBytes: 1_200, inboundPackets: 2, outboundPackets: 1
        ), "framed, VLAN-tagged and bare packets all count, by payload")
        let stats = ledger.snapshot()
        XCTAssertEqual(stats.linkLayerFramed, 2)
        XCTAssertEqual(stats.unreadable, 0)
    }

    func testReadsIPv6BehindAnEthernetHeaderAndIgnoresOtherEtherTypes() {
        var ip = [UInt8](repeating: 0, count: 40 + 8 + 100)
        ip[0] = 0x60
        ip[4] = 0; ip[5] = 108
        ip[6] = 17
        ip[8] = 0x20; ip[9] = 0x01; ip[10] = 0x0d; ip[11] = 0xb8; ip[23] = 1
        ip[24] = 0x20; ip[25] = 0x01; ip[26] = 0x0d; ip[27] = 0xb8; ip[39] = 2
        ip[40] = 0xc3; ip[41] = 0x50; ip[42] = 0x01; ip[43] = 0xbb; ip[44] = 0; ip[45] = 108
        let frame = ethernet(ip, etherType: 0x86dd)
        let header = frame.withUnsafeBytes { PacketTupleParser.header($0, packetLength: frame.count) }
        XCTAssertEqual(header?.payloadLength, 100)
        XCTAssertEqual(header?.tuple.destinationAddress, "2001:db8::2")
        let arp = ethernet([UInt8](repeating: 0x45, count: 28), etherType: 0x0806)
        XCTAssertNil(arp.withUnsafeBytes { PacketTupleParser.header($0, packetLength: arp.count) })
    }

    func testParserReportsPayloadLengthForIPv6TCP() {
        var bytes = [UInt8](repeating: 0, count: 60 + 300)
        bytes[0] = 0x60
        bytes[4] = UInt8((20 + 300) >> 8); bytes[5] = UInt8((20 + 300) & 0xff)
        bytes[6] = 6
        bytes[8] = 0x20; bytes[9] = 0x01; bytes[10] = 0x0d; bytes[11] = 0xb8; bytes[23] = 1
        bytes[24] = 0x20; bytes[25] = 0x01; bytes[26] = 0x0d; bytes[27] = 0xb8; bytes[39] = 2
        bytes[40] = 0xc3; bytes[41] = 0x50; bytes[42] = 0x01; bytes[43] = 0xbb
        bytes[52] = 0x50
        let header = bytes.withUnsafeBytes { PacketTupleParser.header($0, packetLength: bytes.count) }
        XCTAssertEqual(header?.payloadLength, 300)
        XCTAssertEqual(header?.tuple.sourceAddress, "2001:db8::1")
    }
}
