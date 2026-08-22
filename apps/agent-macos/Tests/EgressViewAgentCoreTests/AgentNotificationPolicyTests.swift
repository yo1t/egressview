import XCTest
@testable import EgressViewAgentCore

final class AgentNotificationPolicyTests: XCTestCase {
    func test_同じ事象はcooldown中に繰り返さない() {
        let now = Date(timeIntervalSince1970: 10_000)
        var limiter = AgentNotificationLimiter()
        XCTAssertTrue(limiter.consume(key: "monitoring", now: now))
        XCTAssertFalse(limiter.consume(key: "monitoring", now: now.addingTimeInterval(3_599)))
        XCTAssertTrue(limiter.consume(key: "monitoring", now: now.addingTimeInterval(3_600)))
    }

    func test_異なる事象は独立して通知できる() {
        let now = Date(timeIntervalSince1970: 10_000)
        var limiter = AgentNotificationLimiter()
        XCTAssertTrue(limiter.consume(key: "monitoring", now: now))
        XCTAssertTrue(limiter.consume(key: "hub", now: now))
    }

    func test_日次上限は選択でき抑制数も記録する() {
        let now = Date(timeIntervalSince1970: 10_000)
        var limiter = AgentNotificationLimiter()
        for index in 0..<5 {
            XCTAssertTrue(limiter.consume(
                key: "event-\(index)", now: now, cooldown: 0, dailyLimit: .five
            ))
        }
        XCTAssertFalse(limiter.consume(
            key: "overflow", now: now, cooldown: 0, dailyLimit: .five
        ))
        XCTAssertEqual(limiter.state.suppressedToday, 1)
        XCTAssertTrue(limiter.consume(
            key: "tomorrow", now: now.addingTimeInterval(86_400), cooldown: 0,
            dailyLimit: .five
        ))
        XCTAssertEqual(limiter.state.suppressedToday, 0)
    }

    func test_無制限では日次上限を適用しない() {
        let now = Date(timeIntervalSince1970: 10_000)
        var limiter = AgentNotificationLimiter()
        for index in 0..<30 {
            XCTAssertTrue(limiter.consume(
                key: "event-\(index)", now: now, cooldown: 0, dailyLimit: .unlimited
            ))
        }
        XCTAssertEqual(limiter.state.sentToday, 30)
        XCTAssertEqual(limiter.state.suppressedToday, 0)
    }

    func test_時計が戻った場合も日次上限を安全に再開始する() {
        let now = Date(timeIntervalSince1970: 10_000)
        var limiter = AgentNotificationLimiter(state: AgentNotificationLimiterState(
            dayStartedAt: now,
            sentToday: AgentNotificationDailyLimit.defaultValue.rawValue,
            suppressedToday: 0,
            lastSentByKey: [:]
        ))
        XCTAssertTrue(limiter.consume(key: "clock-reset", now: now.addingTimeInterval(-60)))
    }

    func test_旧保存形式はsuppressedTodayなしでも読める() throws {
        let json = """
        {"dayStartedAt":0,"sentToday":3,"lastSentByKey":{}}
        """.data(using: .utf8)!
        let state = try JSONDecoder().decode(AgentNotificationLimiterState.self, from: json)
        XCTAssertEqual(state.sentToday, 3)
        XCTAssertEqual(state.suppressedToday, 0)
    }
}
