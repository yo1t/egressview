import EgressViewNetworkExtension
import Foundation
import XCTest
@testable import EgressViewAgentCore

/// P3-191: a LAN device probing this Mac, counted from packet headers.
final class InboundProbeCounterTests: XCTestCase {
    private let windowStart = Date(timeIntervalSince1970: 1_800_000_000 / 120 * 120)

    private func syn(_ counter: inout InboundProbeCounter, from source: String = "192.168.1.77",
                     to port: UInt16, flags: UInt8 = 0x02, at offset: TimeInterval = 1) {
        counter.record(networkProtocol: .tcp, sourceAddress: source, destinationAddress: "192.168.1.53",
                       destinationPort: port, tcpFlags: flags, at: windowStart.addingTimeInterval(offset))
    }

    func test1つの送り元が多くのポートへ接続要求を送ると_窓が終わったあとに1件の要約になる() {
        var counter = InboundProbeCounter()
        for port in UInt16(20)..<UInt16(45) { syn(&counter, to: port) }
        syn(&counter, to: 22)
        XCTAssertTrue(counter.takeCompleted(now: windowStart.addingTimeInterval(60)).isEmpty, "窓の途中では出さない")
        let summaries = counter.takeCompleted(now: windowStart.addingTimeInterval(121))
        XCTAssertEqual(summaries.count, 1)
        XCTAssertEqual(summaries[0].sourceAddress, "192.168.1.77")
        XCTAssertEqual(summaries[0].localAddress, "192.168.1.53")
        XCTAssertEqual(summaries[0].networkProtocol, .tcp)
        XCTAssertEqual(summaries[0].distinctPorts, 25)
        XCTAssertEqual(summaries[0].packets, 26)
        XCTAssertEqual(summaries[0].samplePorts, Array(UInt16(20)..<UInt16(30)))
        XCTAssertEqual(summaries[0].windowStart, windowStart)
        XCTAssertTrue(counter.takeCompleted(now: windowStart.addingTimeInterval(500)).isEmpty, "一度出したら忘れる")
    }

    func testACK付きのTCPやこちらの一時ポートに来たUDPは数えない() {
        XCTAssertFalse(InboundProbeCounter.counts(networkProtocol: .tcp, destinationPort: 80, tcpFlags: 0x12), "SYN-ACK")
        XCTAssertFalse(InboundProbeCounter.counts(networkProtocol: .tcp, destinationPort: 80, tcpFlags: 0x10), "ACK")
        XCTAssertFalse(InboundProbeCounter.counts(networkProtocol: .tcp, destinationPort: 80, tcpFlags: nil))
        XCTAssertTrue(InboundProbeCounter.counts(networkProtocol: .udp, destinationPort: 161, tcpFlags: nil))
        XCTAssertFalse(InboundProbeCounter.counts(networkProtocol: .udp, destinationPort: 55_000, tcpFlags: nil), "返事")
    }

    func testLAN外の送り元やマルチキャストとブロードキャスト宛ては数えない() {
        var counter = InboundProbeCounter()
        for port in UInt16(20)..<UInt16(45) {
            syn(&counter, from: "198.51.100.9", to: port)
            counter.record(networkProtocol: .udp, sourceAddress: "192.168.1.77", destinationAddress: "224.0.0.251",
                           destinationPort: port, tcpFlags: nil, at: windowStart.addingTimeInterval(1))
            counter.record(networkProtocol: .udp, sourceAddress: "192.168.1.77", destinationAddress: "192.168.1.255",
                           destinationPort: port, tcpFlags: nil, at: windowStart.addingTimeInterval(1))
        }
        XCTAssertTrue(counter.takeCompleted(now: windowStart.addingTimeInterval(121)).isEmpty)
    }

    func test5ポート未満は報告しない() {
        var counter = InboundProbeCounter()
        for port in UInt16(20)..<UInt16(24) { syn(&counter, to: port) }
        XCTAssertTrue(counter.takeCompleted(now: windowStart.addingTimeInterval(121)).isEmpty)
    }

    func testTCPとUDPは別々に数える() {
        var counter = InboundProbeCounter()
        for port in UInt16(20)..<UInt16(30) {
            syn(&counter, to: port)
            counter.record(networkProtocol: .udp, sourceAddress: "192.168.1.77", destinationAddress: "192.168.1.53",
                           destinationPort: port, tcpFlags: nil, at: windowStart.addingTimeInterval(2))
        }
        let summaries = counter.takeCompleted(now: windowStart.addingTimeInterval(121))
        XCTAssertEqual(Set(summaries.map(\.networkProtocol)), [.tcp, .udp])
    }

    func testTCPのフラグをヘッダーから読む() {
        var bytes = [UInt8](repeating: 0, count: 40)
        bytes[0] = 0x45; bytes[3] = 40; bytes[8] = 64; bytes[9] = 6
        bytes[12] = 192; bytes[13] = 168; bytes[14] = 1; bytes[15] = 77
        bytes[16] = 192; bytes[17] = 168; bytes[18] = 1; bytes[19] = 53
        bytes[20] = 0xc3; bytes[21] = 0x50; bytes[22] = 0; bytes[23] = 22
        bytes[32] = 0x50; bytes[33] = 0x02
        let header = bytes.withUnsafeBytes { PacketTupleParser.header($0, packetLength: 40) }
        XCTAssertEqual(header?.tcpFlags, 0x02)
        XCTAssertEqual(header?.tuple.destinationPort, 22)
    }
}
