import EgressViewAgentCore
import EgressViewNetworkExtension
import Foundation
import XCTest

final class PacketTupleParserTests: XCTestCase {
    private func ipv4UDP(fragment: UInt16 = 0, totalLength: UInt16 = 28) -> Data {
        Data([
            0x45, 0, UInt8(totalLength >> 8), UInt8(totalLength & 0xff), 0, 0,
            UInt8(fragment >> 8), UInt8(fragment & 0xff), 64, 17, 0, 0,
            192, 0, 2, 10, 198, 51, 100, 20,
            0xc3, 0x50, 0x01, 0xbb, 0, 8, 0, 0,
        ])
    }

    private func ipv6TCP(nextHeader: UInt8 = 6) -> Data {
        var bytes = [UInt8](repeating: 0, count: 60)
        bytes[0] = 0x60
        bytes[5] = 20
        bytes[6] = nextHeader
        bytes[7] = 64
        bytes[8] = 0x20; bytes[9] = 0x01; bytes[10] = 0x0d; bytes[11] = 0xb8
        bytes[23] = 1
        bytes[24] = 0x20; bytes[25] = 0x01; bytes[26] = 0x0d; bytes[27] = 0xb8
        bytes[39] = 2
        bytes[40] = 0xc3; bytes[41] = 0x50
        bytes[42] = 0x01; bytes[43] = 0xbb
        bytes[52] = 0x50
        return Data(bytes)
    }

    func testParsesIPv4UDPTupleWithoutReadingPayload() {
        XCTAssertEqual(PacketTupleParser.parse(ipv4UDP()), PacketTuple(
            networkProtocol: .udp,
            sourceAddress: "192.0.2.10", sourcePort: 50_000,
            destinationAddress: "198.51.100.20", destinationPort: 443
        ))
    }

    func testParsesDirectIPv6TCPHeader() {
        XCTAssertEqual(PacketTupleParser.parse(ipv6TCP()), PacketTuple(
            networkProtocol: .tcp,
            sourceAddress: "2001:db8::1", sourcePort: 50_000,
            destinationAddress: "2001:db8::2", destinationPort: 443
        ))
    }

    func testRejectsFragmentsAndUnsupportedIPv6Headers() {
        XCTAssertNil(PacketTupleParser.parse(ipv4UDP(fragment: 0x2000)))
        XCTAssertNil(PacketTupleParser.parse(ipv4UDP(fragment: 1)))
        XCTAssertNil(PacketTupleParser.parse(ipv6TCP(nextHeader: 44)))
    }

    func testRejectsTruncatedOrInconsistentLengths() {
        XCTAssertNil(PacketTupleParser.parse(Data()))
        XCTAssertNil(PacketTupleParser.parse(ipv4UDP().prefix(25)))
        XCTAssertNil(PacketTupleParser.parse(ipv4UDP(totalLength: 27)))
        XCTAssertNil(PacketTupleParser.parse(ipv6TCP().prefix(59)))
    }

    func testParsesHeaderPrefixOfLongPacketsWithoutCopyingPayload() {
        var ipv4 = ipv4UDP(totalLength: 1_028)
        ipv4.append(Data(repeating: 0, count: 1_000))
        XCTAssertNotNil(PacketTupleParser.parseHeaderPrefix(ipv4.prefix(28), packetLength: ipv4.count))
        XCTAssertNil(PacketTupleParser.parseHeaderPrefix(ipv4.prefix(28), packetLength: 27))

        var ipv6 = ipv6TCP()
        ipv6[4] = 0x03
        ipv6[5] = 0xfc
        ipv6.append(Data(repeating: 0, count: 1_000))
        XCTAssertNotNil(PacketTupleParser.parseHeaderPrefix(ipv6.prefix(60), packetLength: ipv6.count))
        XCTAssertNil(PacketTupleParser.parseHeaderPrefix(ipv6.prefix(60), packetLength: 59))
    }
}
