import XCTest
@testable import EgressViewAgentCore

final class LatestWinsRefreshCoordinatorTests: XCTestCase {
    func testSelectionChangesDiscardOldResultAndCoalesceToLatest() {
        var coordinator = LatestWinsRefreshCoordinator()
        let initial = coordinator.requestRefresh()
        XCTAssertNotNil(initial)

        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: true))
        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: true))
        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: true))

        let firstCompletion = coordinator.complete(initial!, shouldContinue: true)
        XCTAssertFalse(firstCompletion.shouldApply)
        XCTAssertNotNil(firstCompletion.next)

        let latestCompletion = coordinator.complete(firstCompletion.next!, shouldContinue: true)
        XCTAssertTrue(latestCompletion.shouldApply)
        XCTAssertNil(latestCompletion.next)
    }

    func testTimerRefreshDoesNotInvalidateResultButSchedulesOneFollowUp() {
        var coordinator = LatestWinsRefreshCoordinator()
        let initial = coordinator.requestRefresh()!

        XCTAssertNil(coordinator.requestRefresh())
        XCTAssertNil(coordinator.requestRefresh())

        let firstCompletion = coordinator.complete(initial, shouldContinue: true)
        XCTAssertTrue(firstCompletion.shouldApply)
        XCTAssertNotNil(firstCompletion.next)

        let followUp = coordinator.complete(firstCompletion.next!, shouldContinue: true)
        XCTAssertTrue(followUp.shouldApply)
        XCTAssertNil(followUp.next)
    }

    func testTabWithoutRefreshInvalidatesActiveResult() {
        var coordinator = LatestWinsRefreshCoordinator()
        let active = coordinator.requestRefresh()!

        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: false))
        let completion = coordinator.complete(active, shouldContinue: false)

        XCTAssertFalse(completion.shouldApply)
        XCTAssertNil(completion.next)
    }

    func testReturningFromNonRefreshingTabStartsLatestSelection() {
        var coordinator = LatestWinsRefreshCoordinator()
        let active = coordinator.requestRefresh()!

        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: false))
        XCTAssertNil(coordinator.selectionChanged(shouldRefresh: true))

        let completion = coordinator.complete(active, shouldContinue: true)
        XCTAssertFalse(completion.shouldApply)
        XCTAssertNotNil(completion.next)
        XCTAssertTrue(
            coordinator.complete(completion.next!, shouldContinue: true).shouldApply
        )
    }
}
