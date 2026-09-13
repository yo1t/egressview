import XCTest
@testable import EgressViewAgentCore

/// Quitting stopped monitoring and looked, at the next login, exactly like the
/// Pause the user never chose (P3-121).
final class MonitoringResumeStateTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "monitoring-resume-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func test何も控えていなければ何も再開しない() {
        // The state someone reaches by turning the extension off in System
        // Settings -- which is how uninstalling starts. Asking them to approve
        // it again at the next login would fight the instructions.
        let state = MonitoringResumeState(defaults: defaults)
        XCTAssertNil(state.takeModeBeforeQuit())
    }

    func test終了時に動いていたものを再開する() {
        let state = MonitoringResumeState(defaults: defaults)
        state.modeBeforeQuit = "full"
        XCTAssertEqual(state.takeModeBeforeQuit(), "full")
    }

    func test控えは一度しか使わない() {
        // A note left behind is indistinguishable from a wish, and a resume
        // that failed must not be retried at every login forever.
        let state = MonitoringResumeState(defaults: defaults)
        state.modeBeforeQuit = "full"
        _ = state.takeModeBeforeQuit()
        XCTAssertNil(state.takeModeBeforeQuit(), "控えが残っている")
    }

    func test一時停止は控えを消す() {
        // Pause is a choice, and it outranks whatever the last quit wrote.
        let state = MonitoringResumeState(defaults: defaults)
        state.modeBeforeQuit = "full"
        state.modeBeforeQuit = nil
        XCTAssertNil(state.takeModeBeforeQuit())
    }

    func test空文字は控えとして扱わない() {
        let state = MonitoringResumeState(defaults: defaults)
        defaults.set("", forKey: MonitoringResumeState.key)
        XCTAssertNil(state.modeBeforeQuit)
    }

    func test控えは再起動をまたいで残る() {
        // The whole point: the note outlives the process that wrote it.
        MonitoringResumeState(defaults: defaults).modeBeforeQuit = "lightweight"
        let afterRelaunch = MonitoringResumeState(defaults: defaults)
        XCTAssertEqual(afterRelaunch.takeModeBeforeQuit(), "lightweight")
    }
}
