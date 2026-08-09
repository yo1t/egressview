import EgressViewAgentCore
import XCTest

final class CollectorCoordinatorTests: XCTestCase {
    func testSwitchStopsOldCollectorBeforeStartingNewCollector() {
        var events: [String] = []
        let full = FakeCollector(kind: .networkExtension, events: { events.append($0) })
        let lightweight = FakeCollector(kind: .libproc, events: { events.append($0) })
        let coordinator = CollectorCoordinator(
            fullFactory: { full },
            lightweightFactory: { lightweight }
        )

        XCTAssertEqual(coordinator.switchMode(to: .lightweight), .active(.lightweight))
        XCTAssertEqual(coordinator.switchMode(to: .full), .active(.full))

        XCTAssertEqual(events, ["start-libproc", "stop-libproc", "start-network-extension"])
        XCTAssertFalse(lightweight.isRunning)
        XCTAssertTrue(full.isRunning)
    }

    func testApprovalFailureDoesNotSilentlyStartLightweightCollector() {
        let full = FakeCollector(kind: .networkExtension, startError: .approvalRequired)
        let lightweight = FakeCollector(kind: .libproc)
        let coordinator = CollectorCoordinator(
            fullFactory: { full },
            lightweightFactory: { lightweight }
        )

        XCTAssertEqual(coordinator.switchMode(to: .full), .approvalRequired)
        XCTAssertEqual(lightweight.startCount, 0)
        XCTAssertEqual(coordinator.selectedMode, .full)
    }

    func testPausedStopsCollection() {
        let lightweight = FakeCollector(kind: .libproc)
        let coordinator = CollectorCoordinator(
            fullFactory: { FakeCollector(kind: .networkExtension) },
            lightweightFactory: { lightweight }
        )

        _ = coordinator.switchMode(to: .lightweight)
        XCTAssertEqual(coordinator.switchMode(to: .paused), .inactive)
        XCTAssertFalse(lightweight.isRunning)
        XCTAssertEqual(lightweight.stopCount, 1)
    }
}

private final class FakeCollector: ObservationCollector {
    let kind: CollectorKind
    private(set) var isRunning = false
    private(set) var startCount = 0
    private(set) var stopCount = 0

    private let startError: CollectorFailure?
    private let events: (String) -> Void

    init(
        kind: CollectorKind,
        startError: CollectorFailure? = nil,
        events: @escaping (String) -> Void = { _ in }
    ) {
        self.kind = kind
        self.startError = startError
        self.events = events
    }

    func start() throws {
        startCount += 1
        events("start-\(kind.rawValue)")
        if let startError { throw startError }
        isRunning = true
    }

    func stop() {
        stopCount += 1
        events("stop-\(kind.rawValue)")
        isRunning = false
    }
}
