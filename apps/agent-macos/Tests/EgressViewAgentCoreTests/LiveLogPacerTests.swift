import XCTest
@testable import EgressViewAgentCore

/// How often the live connection log is allowed to read.
final class LiveLogPacerTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 10_000)

    func test一気に届いても読み出しは1回() {
        // A page load is dozens of flows inside a second.
        var pacer = LiveLogPacer(lastRefreshAt: now)
        XCTAssertNotNil(pacer.schedule(now: now))
        for _ in 0..<100 {
            XCTAssertNil(pacer.schedule(now: now), "burst中に追加の読み出しが積まれた")
        }
    }

    func test直前に読んでいれば待つ() {
        var pacer = LiveLogPacer(interval: 1, lastRefreshAt: now)
        let delay = pacer.schedule(now: now.addingTimeInterval(0.2))
        XCTAssertEqual(try XCTUnwrap(delay), 0.8, accuracy: 0.001)
    }

    func test間隔を過ぎていれば待たない() {
        var pacer = LiveLogPacer(interval: 1, lastRefreshAt: now)
        let delay = pacer.schedule(now: now.addingTimeInterval(30))
        XCTAssertEqual(try XCTUnwrap(delay), 0, accuracy: 0.001)
    }

    func test読み出し後はまた予約できる() {
        var pacer = LiveLogPacer(interval: 1, lastRefreshAt: now)
        _ = pacer.schedule(now: now)
        pacer.refreshed(at: now.addingTimeInterval(1))
        XCTAssertNotNil(pacer.schedule(now: now.addingTimeInterval(2)))
    }

    func test取り消しても次が予約できる() {
        // The defect this prevents: a pending read abandoned because the tab
        // changed would leave the pacer believing one is still coming, and the
        // log would never update again -- quietly, which is the worst way for
        // a live screen to stop.
        var pacer = LiveLogPacer(interval: 1, lastRefreshAt: now)
        _ = pacer.schedule(now: now)
        pacer.cancelled()
        XCTAssertNotNil(pacer.schedule(now: now.addingTimeInterval(2)), "予約が永久に残った")
    }

    func test間隔は取り込み周期から導かれる() {
        // Written as a number, this would keep its value when the drain
        // changed and read the same rows over again.
        XCTAssertEqual(LiveLogPacer.defaultInterval, FullMonitoringXPC.drainInterval)
        XCTAssertGreaterThan(FullMonitoringXPC.drainInterval, 0)
    }
}
