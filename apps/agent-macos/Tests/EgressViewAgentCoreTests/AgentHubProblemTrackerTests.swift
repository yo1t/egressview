import XCTest
@testable import EgressViewAgentCore

/// P3-88。cooldownで落ちた通知が二度と試されず、88分の障害が報告されなかった。
final class AgentHubProblemTrackerTests: XCTestCase {
    func test落ちた通知は続く限り再試行する() {
        // The measured case: one attempt, refused by a cooldown that started
        // before the outage, and then eighty-eight minutes of silence because
        // the state never changed again.
        var tracker = AgentHubProblemTracker()
        XCTAssertTrue(tracker.problem(cause: "unavailable"))
        tracker.attempted(delivered: false)

        let first = tracker.shouldRetryAnnouncement()
        XCTAssertTrue(first.retry, "落ちたまま黙った")
        XCTAssertEqual(first.cause, "unavailable")

        // Still refused; still outstanding.
        tracker.attempted(delivered: false)
        XCTAssertTrue(tracker.shouldRetryAnnouncement().retry)
    }

    func test届いたら繰り返さない() {
        // The cooldown's own job. Retrying is for what never arrived.
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: true)
        XCTAssertFalse(tracker.shouldRetryAnnouncement().retry)
        XCTAssertFalse(tracker.hasUnannouncedProblem)
    }

    func test同じ原因が続く間は二重に数えない() {
        var tracker = AgentHubProblemTracker()
        XCTAssertTrue(tracker.problem(cause: "unavailable"))
        tracker.attempted(delivered: true)
        // The state is re-evaluated constantly; a delivered problem must not
        // become outstanding again just because it is still true.
        XCTAssertFalse(tracker.problem(cause: "unavailable"))
    }

    func test原因が変われば別の知らせとして扱う() {
        // An authorisation failure is not the same news as a retry, and having
        // announced one says nothing about the other.
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: true)
        XCTAssertTrue(tracker.problem(cause: "authorization"))
        XCTAssertTrue(tracker.hasUnannouncedProblem)
    }

    func test知らせていない障害の復旧は言わない() {
        // "Hub delivery recovered" for something the user was never told had
        // broken -- the second half of what was measured on 2026-09-07.
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: false)
        XCTAssertFalse(tracker.recovered(), "壊れたと言わずに直ったと言った")
    }

    func test知らせた障害の復旧は言う() {
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: true)
        XCTAssertTrue(tracker.recovered())
    }

    func test復旧のあとは持ち越さない() {
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: true)
        XCTAssertTrue(tracker.recovered())
        // A second recovery with no problem in between says nothing.
        XCTAssertFalse(tracker.recovered())
        XCTAssertFalse(tracker.shouldRetryAnnouncement().retry)
    }

    func test停止や経路なしは持ち越さない() {
        // Delivery switched off is not an outstanding problem waiting to be
        // announced when it comes back.
        var tracker = AgentHubProblemTracker()
        _ = tracker.problem(cause: "unavailable")
        tracker.attempted(delivered: false)
        tracker.inactive()
        XCTAssertFalse(tracker.shouldRetryAnnouncement().retry)
        XCTAssertFalse(tracker.recovered())
    }

    func test障害が長引くほど出にくいという性質が消えている() {
        // The property the defect had, stated directly: eighty-eight minutes of
        // one unchanging problem used to produce exactly one attempt.
        var tracker = AgentHubProblemTracker()
        var attempts = 0
        if tracker.problem(cause: "unavailable") { attempts += 1 }
        tracker.attempted(delivered: false)
        for _ in 0..<88 {
            if tracker.shouldRetryAnnouncement().retry { attempts += 1 }
            tracker.attempted(delivered: false)
        }
        XCTAssertEqual(attempts, 89, "続いている障害を1回しか試さなかった")
    }
}
