import XCTest
@testable import EgressViewAgentCore

/// P3-85（未達なのに「復旧」）と P3-68（一過性の失敗で警報）の判定規則。
final class AgentDeliveryHealthTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_788_600_000)

    // MARK: - P3-85

    func test滞留したままACKが進まなければ復旧を名乗らない() {
        // The overnight state, exactly: 7,981 observations queued and the last
        // acknowledgement stuck at the moment the Hub became unreachable. The
        // sender passes through idle between retries; that is not delivery.
        //
        // The grace clock starts at the reading that first sees the queue
        // standing still, not at the outage, so this walks the readings the way
        // `render` does rather than jumping to the end.
        var e = AgentDeliveryHealthEvaluator()
        let ack = t0.addingTimeInterval(-9 * 3600)
        var verdict = AgentDeliveryHealthEvaluator.Verdict.inactive
        for minute in 0...20 {
            verdict = e.evaluate(
                isDelivering: true, isProblem: false, isInactive: false,
                pendingCount: 7981, lastAcknowledgedAt: ack,
                now: t0.addingTimeInterval(Double(minute) * 60)
            )
            if minute == 0 {
                // Nothing to compare the acknowledgement against yet.
                XCTAssertEqual(verdict, .healthy)
            } else if minute < 6 {
                XCTAssertEqual(verdict, .settling, "\(minute)分で報告してしまった")
            }
        }
        XCTAssertEqual(verdict, .unavailable, "届いていないのに正常と判定した")
    }

    func testACKが進めば復旧を名乗ってよい() {
        var e = AgentDeliveryHealthEvaluator()
        _ = e.evaluate(isDelivering: true, isProblem: false, isInactive: false,
                       pendingCount: 500, lastAcknowledgedAt: t0, now: t0)
        let verdict = e.evaluate(isDelivering: true, isProblem: false, isInactive: false,
                                 pendingCount: 400, lastAcknowledgedAt: t0.addingTimeInterval(30),
                                 now: t0.addingTimeInterval(30))
        XCTAssertEqual(verdict, .healthy)
    }

    func test送るものが無ければACKを待たずに正常() {
        // An idle agent with an empty queue is not failing at anything, and
        // demanding a fresh acknowledgement would report an outage that is not
        // happening.
        var e = AgentDeliveryHealthEvaluator()
        let verdict = e.evaluate(isDelivering: true, isProblem: false, isInactive: false,
                                 pendingCount: 0, lastAcknowledgedAt: nil, now: t0)
        XCTAssertEqual(verdict, .healthy)
    }

    // MARK: - P3-68

    func test一過性の失敗は猶予の内なら報告しない() {
        // The measured hiccups: the longest gap in accepted batches around a
        // notification was thirty-three seconds.
        var e = AgentDeliveryHealthEvaluator()
        _ = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                       pendingCount: 10, lastAcknowledgedAt: t0, now: t0)
        let verdict = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                                 pendingCount: 10, lastAcknowledgedAt: t0,
                                 now: t0.addingTimeInterval(33))
        XCTAssertEqual(verdict, .settling, "33秒で自己回復する事象を警報にした")
    }

    func test続く失敗は猶予を過ぎたら報告する() {
        var e = AgentDeliveryHealthEvaluator()
        _ = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                       pendingCount: 10, lastAcknowledgedAt: t0, now: t0)
        let verdict = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                                 pendingCount: 10, lastAcknowledgedAt: t0,
                                 now: t0.addingTimeInterval(301))
        XCTAssertEqual(verdict, .unavailable)
    }

    func test回復すると猶予の計測がやり直される() {
        // Otherwise a second, unrelated hiccup an hour later would inherit the
        // first one's age and be reported immediately.
        var e = AgentDeliveryHealthEvaluator()
        _ = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                       pendingCount: 10, lastAcknowledgedAt: t0, now: t0)
        _ = e.evaluate(isDelivering: true, isProblem: false, isInactive: false,
                       pendingCount: 0, lastAcknowledgedAt: t0.addingTimeInterval(30),
                       now: t0.addingTimeInterval(30))
        let verdict = e.evaluate(isDelivering: false, isProblem: true, isInactive: false,
                                 pendingCount: 5, lastAcknowledgedAt: t0.addingTimeInterval(30),
                                 now: t0.addingTimeInterval(3600))
        XCTAssertEqual(verdict, .settling, "前の障害の経過時間を引き継いだ")
    }

    // MARK: - 変えていないこと

    func test停止中や経路なしは警報にしない() {
        // A laptop moving between networks is ordinary. This was already the
        // behaviour and the change must not turn it into an alarm.
        var e = AgentDeliveryHealthEvaluator()
        let verdict = e.evaluate(isDelivering: false, isProblem: false, isInactive: true,
                                 pendingCount: 900, lastAcknowledgedAt: nil, now: t0)
        XCTAssertEqual(verdict, .inactive)
    }

    func test初回にACKがあっても進んだとは数えない場合() {
        // First reading with a queue and an acknowledgement we have never seen
        // before: treat it as advanced, because there is nothing to compare
        // against and refusing would report an outage on every launch.
        var e = AgentDeliveryHealthEvaluator()
        XCTAssertNil(e.lastObservedAcknowledgement)
        let verdict = e.evaluate(isDelivering: true, isProblem: false, isInactive: false,
                                 pendingCount: 100, lastAcknowledgedAt: t0, now: t0)
        XCTAssertEqual(verdict, .healthy)
        XCTAssertEqual(e.lastObservedAcknowledgement, t0)
    }
}
