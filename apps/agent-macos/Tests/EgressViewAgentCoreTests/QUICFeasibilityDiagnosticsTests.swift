import XCTest
@testable import EgressViewAgentCore

final class QUICFeasibilityDiagnosticsTests: XCTestCase {
    func test_QUIC_v1のInitial候補を認識する() {
        XCTAssertEqual(QUICInitialProbe.classify(longHeader(version: 1, type: 0x00)), .version1)
    }

    func test_QUIC_v2のInitial候補を認識する() {
        XCTAssertEqual(
            QUICInitialProbe.classify(longHeader(version: 0x6b33_43cf, type: 0x10)),
            .version2
        )
    }

    func test_short_headerやVersion_Negotiationや壊れたCID長を拒否する() {
        XCTAssertEqual(QUICInitialProbe.classify(Data([0x40, 0, 0, 0, 1, 0, 0])), .notQUICInitial)
        XCTAssertEqual(QUICInitialProbe.classify(longHeader(version: 0, type: 0)), .notQUICInitial)
        XCTAssertEqual(
            QUICInitialProbe.classify(Data([0xc0, 0, 0, 0, 1, 21, 0])),
            .notQUICInitial
        )
    }

    func test_既知versionのInitial以外はlong_headerとしてだけ数える() {
        XCTAssertEqual(
            QUICInitialProbe.classify(longHeader(version: 1, type: 0x20)),
            .unsupportedVersionLongHeader
        )
        XCTAssertEqual(
            QUICInitialProbe.classify(longHeader(version: 0xff00_001d, type: 0)),
            .unsupportedVersionLongHeader
        )
    }

    func test_診断値は件数とバイト数だけを保持する() throws {
        let started = Date(timeIntervalSince1970: 100)
        var diagnostics = QUICFeasibilityDiagnostics(startedAt: started)
        diagnostics.recordUDP443Flow(at: started.addingTimeInterval(1))
        diagnostics.recordOutboundCallback(
            offset: 0,
            byteCount: 1_200,
            classification: .version1,
            at: started.addingTimeInterval(2)
        )

        XCTAssertEqual(diagnostics.udp443Flows, 1)
        XCTAssertEqual(diagnostics.outboundCallbacks, 1)
        XCTAssertEqual(diagnostics.zeroOffsetCallbacks, 1)
        XCTAssertEqual(diagnostics.inspectedBytes, 1_200)
        XCTAssertEqual(diagnostics.initialCandidates, 1)
        let encoded = try FullMonitoringXPC.encoder().encode(diagnostics)
        let json = try XCTUnwrap(String(data: encoded, encoding: .utf8))
        XCTAssertFalse(json.contains("address"))
        XCTAssertFalse(json.contains("hostname"))
        XCTAssertFalse(json.contains("payload"))
    }

    private func longHeader(version: UInt32, type: UInt8) -> Data {
        Data([
            0xc0 | type,
            UInt8((version >> 24) & 0xff), UInt8((version >> 16) & 0xff),
            UInt8((version >> 8) & 0xff), UInt8(version & 0xff),
            1, 0xaa, // destination connection ID
            1, 0xbb, // source connection ID
            0, 1, 0,
        ])
    }
}
