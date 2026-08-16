import XCTest
@testable import EgressViewAgentCore

final class ThreatIntelFetcherTests: XCTestCase {
    private func decode(_ json: String) throws -> ThreatIntelFetchResult {
        try ThreatIntelFetcher.decode(Data(json.utf8), etag: "W/\"x\"")
    }

    func test_3種類の指標を読み込む() throws {
        let result = try decode("""
        {"schemaVersion":1,"available":true,
         "ips":[["203.0.113.7","feodo","Dridex C2"]],
         "domains":[["bad.example","urlhaus","malware"]],
         "cidrs":[["198.51.100.0/24","spamhaus","DROP"]]}
        """)
        guard case .updated(let indicators, let etag, _) = result else {
            return XCTFail("updatedを期待した: \(result)")
        }
        XCTAssertEqual(indicators.count, 3)
        XCTAssertEqual(etag, "W/\"x\"")
        XCTAssertEqual(indicators.filter { $0.kind == .cidr }.first?.value, "198.51.100.0/24")
    }

    /// "Nobody looked" and "nothing was found" are different facts. Collapsing
    /// them would show an unexamined period as a clean one.
    func test_フィードの無いHubは空集合ではなく専用の結果を返す() throws {
        let result = try decode("""
        {"schemaVersion":1,"available":false,"ips":[],"domains":[],"cidrs":[]}
        """)
        XCTAssertEqual(result, .hubHasNoFeeds)
    }

    func test_知らないschemaVersionは拒否する() {
        XCTAssertThrowsError(try decode("""
        {"schemaVersion":99,"available":true,"ips":[],"domains":[],"cidrs":[]}
        """)) { error in
            XCTAssertEqual(error as? ThreatIntelFetchError, .unsupportedSchemaVersion(99))
        }
    }

    func test_壊れた本文は拒否する() {
        XCTAssertThrowsError(try decode("not json")) { error in
            XCTAssertEqual(error as? ThreatIntelFetchError, .malformedPayload)
        }
    }

    /// One bad row must not cost the user every indicator the Hub holds.
    func test_壊れた行だけを捨てて残りは読む() throws {
        let result = try decode("""
        {"schemaVersion":1,"available":true,
         "ips":[[""],[123],["203.0.113.7","feodo","Dridex C2"]],
         "domains":[],"cidrs":[]}
        """)
        guard case .updated(let indicators, _, _) = result else {
            return XCTFail("updatedを期待した")
        }
        XCTAssertEqual(indicators.count, 1)
        XCTAssertEqual(indicators.first?.value, "203.0.113.7")
    }

    func test_取得時刻を読み取る() throws {
        let result = try decode("""
        {"schemaVersion":1,"available":true,"fetchedAt":"2026-08-16T09:00:00Z",
         "ips":[],"domains":[],"cidrs":[]}
        """)
        guard case .updated(_, _, let fetchedAt) = result else {
            return XCTFail("updatedを期待した")
        }
        XCTAssertNotNil(fetchedAt)
    }

    func test_source_tagが欠けていても読み込む() throws {
        let result = try decode("""
        {"schemaVersion":1,"available":true,"ips":[["203.0.113.7"]],"domains":[],"cidrs":[]}
        """)
        guard case .updated(let indicators, _, _) = result else {
            return XCTFail("updatedを期待した")
        }
        XCTAssertNil(indicators.first?.source)
    }
}

final class ThreatReportTests: XCTestCase {
    private func candidate(
        _ address: String, hostname: String? = nil, process: String = "curl", sessions: Int = 1
    ) -> ThreatCandidate {
        ThreatCandidate(
            address: address, hostname: hostname, processName: process,
            sessionCount: sessions, lastObservedAt: Date(timeIntervalSince1970: 1_700_000_000)
        )
    }

    private let matcher = ThreatMatcher(indicators: [
        ThreatIndicator(kind: .ip, value: "203.0.113.7", source: "feodo", tag: "Dridex C2"),
    ])

    func test_一致した宛先だけを返し件数の多い順に並べる() {
        let report = ThreatReport.evaluate(
            candidates: [
                candidate("198.51.100.1"),
                candidate("203.0.113.7", process: "curl", sessions: 3),
                candidate("203.0.113.7", process: "Safari", sessions: 9),
            ],
            matcher: matcher,
            availability: .checked(indicatorCount: 1, fetchedAt: nil)
        )
        XCTAssertEqual(report.findings.count, 2)
        XCTAssertEqual(report.findings.first?.candidate.processName, "Safari")
    }

    /// One bad address reached by three apps is one destination to worry
    /// about, not three.
    func test_件数は重複しない宛先の数() {
        let report = ThreatReport.evaluate(
            candidates: [
                candidate("203.0.113.7", process: "curl"),
                candidate("203.0.113.7", process: "Safari"),
            ],
            matcher: matcher,
            availability: .checked(indicatorCount: 1, fetchedAt: nil)
        )
        XCTAssertEqual(report.findings.count, 2)
        XCTAssertEqual(report.destinationCount, 1)
    }

    /// The screen must never present "we never looked" as "we found nothing".
    func test_指標を持たない状態では調べたことにしない() {
        for availability: ThreatIntelAvailability in [.notEnabled, .hubHasNoFeeds, .notFetchedYet] {
            let report = ThreatReport.evaluate(
                candidates: [candidate("203.0.113.7")],
                matcher: matcher,
                availability: availability
            )
            XCTAssertTrue(report.findings.isEmpty)
            XCTAssertFalse(report.wasChecked, "\(availability) を調査済みとして扱わない")
        }
    }

    func test_調べて何も無ければ調査済みかつ0件() {
        let report = ThreatReport.evaluate(
            candidates: [candidate("198.51.100.1")],
            matcher: matcher,
            availability: .checked(indicatorCount: 1, fetchedAt: nil)
        )
        XCTAssertTrue(report.wasChecked)
        XCTAssertEqual(report.destinationCount, 0)
    }
}
