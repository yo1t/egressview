import XCTest
@testable import EgressViewAgentCore

final class ThreatCandidateRefreshCacheTests: XCTestCase {
    private let candidate = ThreatCandidate(
        address: "203.0.113.10",
        hostname: "example.test",
        processName: "Browser",
        sessionCount: 1,
        lastObservedAt: Date(timeIntervalSince1970: 100)
    )

    func test_week表示は期限内なら重い候補集計を再実行しない() throws {
        let cache = ThreatCandidateRefreshCache(longWindowTTL: 300)
        let now = Date(timeIntervalSince1970: 1_000)
        var loads = 0

        for offset in [0.0, 15.0, 299.0] {
            _ = try cache.candidates(scale: .week, now: now.addingTimeInterval(offset)) {
                loads += 1
                return [candidate]
            }
        }

        XCTAssertEqual(loads, 1)
    }

    func test_短い期間は毎回更新する() throws {
        let cache = ThreatCandidateRefreshCache(longWindowTTL: 300)
        var loads = 0

        for scale in [TimeScale.hour, .sixHours, .day] {
            _ = try cache.candidates(scale: scale) {
                loads += 1
                return [candidate]
            }
        }

        XCTAssertEqual(loads, 3)
    }

    func test_期限切れと期間変更と明示失効は再集計する() throws {
        let cache = ThreatCandidateRefreshCache(longWindowTTL: 300)
        let now = Date(timeIntervalSince1970: 1_000)
        var loads = 0
        let load = {
            loads += 1
            return [self.candidate]
        }

        _ = try cache.candidates(scale: .week, now: now, load: load)
        _ = try cache.candidates(scale: .week, now: now.addingTimeInterval(301), load: load)
        _ = try cache.candidates(scale: .month, now: now.addingTimeInterval(302), load: load)
        cache.invalidate()
        _ = try cache.candidates(scale: .month, now: now.addingTimeInterval(303), load: load)

        XCTAssertEqual(loads, 4)
    }
}
