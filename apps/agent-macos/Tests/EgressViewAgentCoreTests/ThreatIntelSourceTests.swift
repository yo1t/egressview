import XCTest
@testable import EgressViewAgentCore

/// Protects the source boundary: Hub is always primary when enrolled, and a
/// public-feed fallback requires explicit permission plus a stale cache.
final class ThreatIntelSourceTests: XCTestCase {
    func test_Hub登録済みならHubが常に第一取得元() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: true, isDirectDownloadEnabled: false),
            .hub
        )
    }

    /// The opt-in is not offered while enrolled, but a value left over from
    /// before enrolment must not resurrect the third-party path.
    func test_Hub登録済みならstandalone設定が残っていても第一取得元はHub() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: true, isDirectDownloadEnabled: true),
            .hub
        )
    }

    func test_Hubなしでopt_inしていれば単独取得() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: false, isDirectDownloadEnabled: true),
            .directDownload
        )
    }

    /// Not "no threats" -- nobody looked. The screen has to say which.
    func test_Hubなしでopt_inしていなければ何も取得しない() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: false, isDirectDownloadEnabled: false),
            .none
        )
    }

    /// The rule has no way to see reachability, so no amount of Hub downtime
    /// can change its answer. Pinned by the signature itself: there is no
    /// parameter for it, and adding one would fail to compile here.
    func test_到達性は判断材料に入らない() {
        let enrolled = [true, false]
        let optedIn = [true, false]
        for hub in enrolled {
            for opt in optedIn {
                let first = ThreatIntelSource.decide(
                    isEnrolledWithHub: hub, isDirectDownloadEnabled: opt
                )
                let second = ThreatIntelSource.decide(
                    isEnrolledWithHub: hub, isDirectDownloadEnabled: opt
                )
                XCTAssertEqual(first, second, "同じ入力なら常に同じ取得元")
                if hub { XCTAssertEqual(first, .hub) }
            }
        }
    }

    func test_Hub_fallbackは明示許可がなければ実行しない() {
        XCTAssertFalse(
            ThreatIntelFallbackPolicy.shouldDownload(
                isEnabled: false,
                hasCachedIndicators: false,
                lastSuccessfulFetch: nil
            )
        )
    }

    func test_Hub_fallbackは新しいcacheがあれば待つ() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        XCTAssertFalse(
            ThreatIntelFallbackPolicy.shouldDownload(
                isEnabled: true,
                hasCachedIndicators: true,
                lastSuccessfulFetch: now.addingTimeInterval(-3_600),
                now: now
            )
        )
    }

    func test_Hub_fallbackはcacheが一日古ければ許可する() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        XCTAssertTrue(
            ThreatIntelFallbackPolicy.shouldDownload(
                isEnabled: true,
                hasCachedIndicators: true,
                lastSuccessfulFetch: now.addingTimeInterval(-ThreatIntelFallbackPolicy.cacheMaxAge),
                now: now
            )
        )
        XCTAssertTrue(
            ThreatIntelFallbackPolicy.shouldDownload(
                isEnabled: true,
                hasCachedIndicators: false,
                lastSuccessfulFetch: nil,
                now: now
            )
        )
    }

    func test_Hub_fallbackは時刻が新しくてもcacheが空なら許可する() {
        let now = Date(timeIntervalSince1970: 2_000_000)
        XCTAssertTrue(
            ThreatIntelFallbackPolicy.shouldDownload(
                isEnabled: true,
                hasCachedIndicators: false,
                lastSuccessfulFetch: now,
                now: now
            )
        )
    }

    func test_Hub_fallback設定は既定OFFで明示的な選択だけを保存する() {
        let suite = "ThreatIntelSourceTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ThreatIntelPreferences(defaults: defaults)

        XCTAssertFalse(preferences.isHubFallbackEnabled)
        preferences.isHubFallbackEnabled = true
        XCTAssertTrue(ThreatIntelPreferences(defaults: defaults).isHubFallbackEnabled)
        preferences.isHubFallbackEnabled = false
        XCTAssertFalse(ThreatIntelPreferences(defaults: defaults).isHubFallbackEnabled)
    }
}
