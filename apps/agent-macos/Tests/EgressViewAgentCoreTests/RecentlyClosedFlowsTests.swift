@testable import EgressViewNetworkExtension
import Foundation
import XCTest

final class RecentlyClosedFlowsTests: XCTestCase {
    func testSecondCloseOfTheSameFlowIsADuplicate() {
        var closed = RecentlyClosedFlows()
        let flow = UUID()
        XCTAssertTrue(closed.recordClose(flow, at: 100))
        XCTAssertFalse(closed.recordClose(flow, at: 100.001))
        XCTAssertTrue(closed.recordClose(UUID(), at: 100.002))
    }

    func testAFlowIsForgottenAfterItsLifetime() {
        var closed = RecentlyClosedFlows(lifetime: 60)
        let flow = UUID()
        XCTAssertTrue(closed.recordClose(flow, at: 100))
        XCTAssertTrue(closed.recordClose(UUID(), at: 161))
        XCTAssertTrue(closed.recordClose(flow, at: 161))
    }

    func testMemoryStaysWithinCapacity() {
        var closed = RecentlyClosedFlows(capacity: 3, lifetime: 600)
        let first = UUID()
        XCTAssertTrue(closed.recordClose(first, at: 0))
        for index in 1...5 { XCTAssertTrue(closed.recordClose(UUID(), at: TimeInterval(index))) }
        XCTAssertEqual(closed.count, 3)
        // The oldest was dropped to make room, so it no longer reads as a duplicate.
        XCTAssertTrue(closed.recordClose(first, at: 6))
    }

    func testLongRunsReclaimTheirOrderAndKeepAnswering() {
        var closed = RecentlyClosedFlows(capacity: 100, lifetime: 1)
        var last = UUID()
        for index in 0..<5_000 {
            last = UUID()
            XCTAssertTrue(closed.recordClose(last, at: TimeInterval(index)))
        }
        XCTAssertLessThanOrEqual(closed.count, 100)
        XCTAssertFalse(closed.recordClose(last, at: 4_999.5))
    }
}
