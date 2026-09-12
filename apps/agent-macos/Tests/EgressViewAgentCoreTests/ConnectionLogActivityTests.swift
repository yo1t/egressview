import XCTest
@testable import EgressViewAgentCore

/// Whether a connection log row is still moving.
///
/// The log's rows are aggregates that keep being updated while traffic
/// continues, so the last-seen time in a row can be a live number or a
/// finished one. Saying which is the reason the column can be trusted
/// (P3-107).
final class ConnectionLogActivityTests: XCTestCase {
    private let snapshot = Date(timeIntervalSince1970: 10_000)

    func test直前に観測された行は継続中() {
        XCTAssertTrue(ConnectionLogActivity.isRunning(
            lastObservedAt: snapshot.addingTimeInterval(-1), snapshotTakenAt: snapshot
        ))
    }

    func test古い行は継続中ではない() {
        XCTAssertFalse(ConnectionLogActivity.isRunning(
            lastObservedAt: snapshot.addingTimeInterval(-60), snapshotTakenAt: snapshot
        ))
    }

    func test判定は採取間隔から導かれる() {
        // Written as a number, this would keep the old value when the sampling
        // rate changed and start calling live connections finished. The same
        // shape as the four chart defects: a constant nobody checks.
        XCTAssertEqual(
            ConnectionLogActivity.runningTolerance,
            LightweightCollector.defaultInterval * 3,
            accuracy: 0.001
        )
        XCTAssertGreaterThan(LightweightCollector.defaultInterval, 0)
    }

    func test許容範囲の内と外() {
        let tolerance = ConnectionLogActivity.runningTolerance
        XCTAssertTrue(ConnectionLogActivity.isRunning(
            lastObservedAt: snapshot.addingTimeInterval(-tolerance + 0.1), snapshotTakenAt: snapshot
        ))
        XCTAssertFalse(ConnectionLogActivity.isRunning(
            lastObservedAt: snapshot.addingTimeInterval(-tolerance - 0.1), snapshotTakenAt: snapshot
        ))
    }

    func test採取が読み取りをまたいでも継続中のまま() {
        // A sample that lands while the window is reading stamps a row after
        // the snapshot. That is a running connection, not an impossible one.
        XCTAssertTrue(ConnectionLogActivity.isRunning(
            lastObservedAt: snapshot.addingTimeInterval(1), snapshotTakenAt: snapshot
        ))
    }

    func test壁時計ではなくその画面の時点で判定する() {
        // The window refreshes on a 15 second timer, so "now" drifts away from
        // the data between refreshes. Judged against the wall clock, the
        // marker would switch itself off while nothing changed on the Mac --
        // reporting the refresh timer rather than the connection.
        let lastSeen = snapshot.addingTimeInterval(-1)
        let muchLater = snapshot.addingTimeInterval(600)
        XCTAssertTrue(ConnectionLogActivity.isRunning(
            lastObservedAt: lastSeen, snapshotTakenAt: snapshot
        ))
        XCTAssertFalse(ConnectionLogActivity.isRunning(
            lastObservedAt: lastSeen, snapshotTakenAt: muchLater
        ),
        "画面の時点が進めば、同じ行は継続中ではなくなる")
    }
}
