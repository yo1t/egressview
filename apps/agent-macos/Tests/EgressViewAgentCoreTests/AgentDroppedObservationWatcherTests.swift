import XCTest
@testable import EgressViewAgentCore

/// P3-21 判定基準5: 既存の累積値では通知せず、新規増加だけで通知する。
final class AgentDroppedObservationWatcherTests: XCTestCase {
    func test既存の累積値では通知しない() {
        // The state this Mac was actually in on 2026-09-06: the queue file
        // carried contractRejectedCount = 7 across the 0.5.50 install, and no
        // drop notification was sent. An alarm about a drop that happened days
        // ago is one people learn to close without reading.
        var watcher = AgentDroppedObservationWatcher()
        XCTAssertFalse(watcher.observe(queueOverflowCount: 0, contractRejectedCount: 7))
    }

    func test新規増加で通知する() {
        var watcher = AgentDroppedObservationWatcher()
        _ = watcher.observe(queueOverflowCount: 0, contractRejectedCount: 7)
        XCTAssertTrue(watcher.observe(queueOverflowCount: 0, contractRejectedCount: 8))
    }

    func testどちらの計数が増えても通知する() {
        // The two counters are different losses -- a full queue and a payload
        // the Hub refused -- and the user is told the same thing either way,
        // so neither may be the only one watched.
        var overflow = AgentDroppedObservationWatcher()
        _ = overflow.observe(queueOverflowCount: 3, contractRejectedCount: 0)
        XCTAssertTrue(overflow.observe(queueOverflowCount: 4, contractRejectedCount: 0))

        var rejected = AgentDroppedObservationWatcher()
        _ = rejected.observe(queueOverflowCount: 0, contractRejectedCount: 3)
        XCTAssertTrue(rejected.observe(queueOverflowCount: 0, contractRejectedCount: 4))
    }

    func test変化がなければ繰り返し読んでも通知しない() {
        // `render` runs on every sender state change, not only when the
        // counters move. Repeating the alarm for one loss would be the same
        // notification fatigue by a different route.
        var watcher = AgentDroppedObservationWatcher()
        _ = watcher.observe(queueOverflowCount: 1, contractRejectedCount: 1)
        XCTAssertTrue(watcher.observe(queueOverflowCount: 2, contractRejectedCount: 1))
        XCTAssertFalse(watcher.observe(queueOverflowCount: 2, contractRejectedCount: 1))
        XCTAssertFalse(watcher.observe(queueOverflowCount: 2, contractRejectedCount: 1))
    }

    func test減少では通知しない() {
        // The queue file can be replaced -- an unreadable one is started empty
        // rather than stopping collection -- so the total can fall. That is a
        // reset, not a new loss.
        var watcher = AgentDroppedObservationWatcher()
        _ = watcher.observe(queueOverflowCount: 5, contractRejectedCount: 5)
        XCTAssertFalse(watcher.observe(queueOverflowCount: 0, contractRejectedCount: 0))
        // ...and the next increase after the reset is news again.
        XCTAssertTrue(watcher.observe(queueOverflowCount: 0, contractRejectedCount: 1))
    }

    func test最初の読み取りは未読と区別できる() {
        var watcher = AgentDroppedObservationWatcher()
        XCTAssertNil(watcher.lastObservedTotal)
        _ = watcher.observe(queueOverflowCount: 0, contractRejectedCount: 0)
        XCTAssertEqual(watcher.lastObservedTotal, 0)
    }
}
