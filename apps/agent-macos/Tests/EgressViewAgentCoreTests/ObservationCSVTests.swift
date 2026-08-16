import XCTest
@testable import EgressViewAgentCore

final class ObservationCSVTests: XCTestCase {
    private func observation(
        processName: String = "Safari",
        bundleID: String? = "com.apple.Safari",
        remoteHostname: String? = "example.com",
        bytesIn: UInt64? = 1200,
        bytesOut: UInt64? = 340
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.5",
            localPort: 51234,
            remoteAddress: "198.51.100.10",
            remotePort: 443,
            processID: 501,
            processName: processName,
            bundleID: bundleID,
            firstObservedAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastObservedAt: Date(timeIntervalSince1970: 1_700_000_060),
            bytesIn: bytesIn,
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: remoteHostname
        )
    }

    private func rows(_ csv: String) -> [String] {
        csv.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
    }

    func test_見出し行と1件の行を書き出す() {
        let csv = ObservationCSV.export([observation()])
        let lines = rows(csv)
        XCTAssertEqual(lines.first, ObservationCSV.columns.joined(separator: ","))
        XCTAssertEqual(lines.count, 3, "見出し・データ1行・末尾の改行")
        XCTAssertTrue(lines[1].contains("198.51.100.10"))
        XCTAssertTrue(lines[1].contains("2023-11-14T"))
    }

    func test_末尾に改行を付ける() {
        XCTAssertTrue(ObservationCSV.export([observation()]).hasSuffix("\n"))
    }

    func test_観測が無くても見出しだけは書き出す() {
        XCTAssertEqual(ObservationCSV.export([]), ObservationCSV.columns.joined(separator: ",") + "\n")
    }

    /// An app name with a comma would otherwise shift every later column.
    func test_カンマを含む値は引用符で囲む() {
        let csv = ObservationCSV.export([observation(processName: "Acme, Inc. Helper")])
        XCTAssertTrue(rows(csv)[1].contains("\"Acme, Inc. Helper\""))
    }

    func test_引用符は二重にして囲む() {
        let csv = ObservationCSV.export([observation(processName: "say \"hi\"")])
        XCTAssertTrue(rows(csv)[1].contains("\"say \"\"hi\"\"\""))
    }

    func test_改行を含む値でも行が壊れない() {
        let csv = ObservationCSV.export([observation(processName: "two\nlines")])
        XCTAssertTrue(csv.contains("\"two\nlines\""))
    }

    func test_引用が要らない値は囲まない() {
        XCTAssertEqual(ObservationCSV.field("Safari"), "Safari")
    }

    /// Empty means "not measured". A zero would claim the connection moved no
    /// data, which is a different and false statement.
    func test_未計測のバイト数は0ではなく空にする() {
        let csv = ObservationCSV.export([observation(bytesIn: nil, bytesOut: nil)])
        let fields = rows(csv)[1].components(separatedBy: ",")
        let bytesIn = try? XCTUnwrap(ObservationCSV.columns.firstIndex(of: "bytes_in"))
        XCTAssertEqual(fields[try! XCTUnwrap(bytesIn)], "")
        XCTAssertFalse(rows(csv)[1].contains(",0,"))
    }

    func test_欠けている名前は空欄になる() {
        let csv = ObservationCSV.export([observation(bundleID: nil, remoteHostname: nil)])
        XCTAssertTrue(rows(csv)[1].contains(",,"))
    }

    func test_ファイル名に期間が入る() {
        let name = ObservationCSV.suggestedFileName(
            from: Date(timeIntervalSince1970: 1_700_000_000),
            to: Date(timeIntervalSince1970: 1_700_003_600)
        )
        XCTAssertTrue(name.hasPrefix("egressview-"))
        XCTAssertTrue(name.hasSuffix(".csv"))
        XCTAssertTrue(name.contains("-to-"))
    }
}
