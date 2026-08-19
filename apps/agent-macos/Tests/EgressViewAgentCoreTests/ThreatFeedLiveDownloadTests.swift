import XCTest
@testable import EgressViewAgentCore

/// Actually downloads the public feeds, once, on purpose.
///
/// Skipped unless `EGRESSVIEW_LIVE_FEEDS=1`. It must never run in CI or by
/// accident: the download sends no destination anywhere, but it does tell the
/// feed operators that this Mac asked, and that is the user's decision to make
/// rather than a side effect of running the test suite.
///
/// It exists because the standalone path shipped without ever having been run.
/// The parsers are covered by fixtures; what was untested is whether the real
/// feeds still look like the fixtures do.
final class ThreatFeedLiveDownloadTests: XCTestCase {
    func test_公開フィードを実際に取得して解析できる() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["EGRESSVIEW_LIVE_FEEDS"] == "1",
            "第三者へ実際に接続するため、明示的に有効化したときだけ実行する"
        )

        let indicators = try await ThreatFeedDownloader().download()
        XCTAssertFalse(indicators.isEmpty, "1件も取れないなら経路か解析が壊れている")

        // Asserted, not just printed. The first run of this test returned
        // 1,693 indicators and passed, and every one of them came from a single
        // feed -- the other three parsed to nothing. "Not empty" is not enough
        // when a silently skipped feed looks exactly like a quiet one.
        let kinds = Set(indicators.map(\.kind))
        let sources = Set(indicators.compactMap(\.source))
        XCTAssertTrue(sources.contains("spamhaus"), "sources=\(sources.sorted())")
        XCTAssertTrue(sources.contains("threatfox"), "sources=\(sources.sorted())")
        XCTAssertTrue(sources.contains("urlhaus"), "sources=\(sources.sorted())")
        XCTAssertTrue(kinds.contains(.ip), "kinds=\(kinds.map(\.rawValue).sorted())")
        XCTAssertTrue(kinds.contains(.domain), "kinds=\(kinds.map(\.rawValue).sorted())")
        XCTAssertTrue(kinds.contains(.cidr), "kinds=\(kinds.map(\.rawValue).sorted())")
        // Feodo publishes an empty list for long stretches, so it is not
        // required here -- that is a real state, not a failure.
        print("live feeds: \(indicators.count) indicators, kinds=\(kinds.map(\.rawValue).sorted()), sources=\(sources.sorted())")

        // A matcher built from them must be usable, which is the only thing the
        // agent ever does with the result.
        let matcher = ThreatMatcher(indicators: indicators)
        XCTAssertFalse(matcher.isEmpty)
        // The matcher keys addresses and domains by value, so duplicates across
        // feeds collapse -- 22,329 live indicators become about ten thousand
        // distinct ones. What must not happen is an indicator being dropped for
        // any other reason, so the expected count is computed the same way.
        let distinctIPs = Set(indicators.filter { $0.kind == .ip }.map(\.value))
        let distinctDomains = Set(indicators.filter { $0.kind == .domain }.map { $0.value.lowercased() })
        let usableCIDRs = indicators.filter { $0.kind == .cidr && ThreatMatcher.parseCIDR($0.value) != nil }
        XCTAssertEqual(
            matcher.count,
            distinctIPs.count + distinctDomains.count + usableCIDRs.count,
            "重複の畳み込み以外の理由で指標が落ちている"
        )
    }
}
