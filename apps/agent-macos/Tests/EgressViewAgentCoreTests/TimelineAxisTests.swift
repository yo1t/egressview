import XCTest
@testable import EgressViewAgentCore

/// P3-87。1.71 GBのスパイクが縦軸を決め、残り23時間が高さ0になった。
final class TimelineAxisTests: XCTestCase {
    func test一本のスパイクが一日を潰さない() {
        // The measured shape: one hour at 1.71 GB against a day of tens of MB.
        var totals = Array(repeating: 30.0e6, count: 23)
        totals.insert(1.71e9, at: 3)
        let axis = TimelineAxis.fit(totals: totals)
        XCTAssertTrue(axis.hasClipping, "スパイクが軸を独占したまま")
        XCTAssertEqual(axis.clipped, [3])
        XCTAssertEqual(axis.peak, 1.71e9)
        // The rest of the day is now drawn against something it can fill.
        XCTAssertLessThan(axis.top, 1.71e9 / 10)
        XCTAssertGreaterThan(axis.top, 30.0e6)
    }

    func test普通の山谷は切らない() {
        // A busy hour against a quiet one is the data, not an outlier. The
        // connections view never needed this and must not start clipping.
        let totals = [100.0, 250, 400, 180, 320, 90, 500, 210]
        let axis = TimelineAxis.fit(totals: totals)
        XCTAssertFalse(axis.hasClipping, "通常の変動を外れ値として切った")
        XCTAssertEqual(axis.top, 500)
        XCTAssertNil(axis.peak)
    }

    func test切った本数を数える() {
        // Two spikes of the same size: neither is "the" outlier on its own, so
        // both stand above the rest and both are marked.
        var totals = Array(repeating: 10.0, count: 10)
        totals[2] = 1000
        totals[7] = 1000
        let axis = TimelineAxis.fit(totals: totals)
        XCTAssertEqual(axis.clipped.sorted(), [2, 7])
    }

    func test境界のちょうど4倍は切らない() {
        // The ratio is where the rule turns; state which side the boundary
        // falls on rather than leaving it to a reader of the arithmetic.
        let axis = TimelineAxis.fit(totals: [100, 400])
        XCTAssertTrue(axis.hasClipping)
        let below = TimelineAxis.fit(totals: [100, 399])
        XCTAssertFalse(below.hasClipping)
    }

    func test全部同じ高さなら切らない() {
        let axis = TimelineAxis.fit(totals: [50, 50, 50])
        XCTAssertFalse(axis.hasClipping)
        XCTAssertEqual(axis.top, 50)
    }

    func test空と全ゼロで落ちない() {
        XCTAssertEqual(TimelineAxis.fit(totals: []).top, 0)
        XCTAssertFalse(TimelineAxis.fit(totals: [0, 0, 0]).hasClipping)
    }

    func test一本しか値が無ければ切らない() {
        // Nothing to compare it against, so it is the scale rather than an
        // outlier against it.
        let axis = TimelineAxis.fit(totals: [0, 0, 900, 0])
        XCTAssertFalse(axis.hasClipping)
        XCTAssertEqual(axis.top, 900)
    }
}
