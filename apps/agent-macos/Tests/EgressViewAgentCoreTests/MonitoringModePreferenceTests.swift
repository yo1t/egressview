import XCTest
@testable import EgressViewAgentCore

/// The setting that had nowhere to live. Quitting disables the filter on
/// purpose, and the launch path used to read the filter's state as the user's
/// wish -- so a quit and a Pause were the same thing at the next login
/// (P3-121).
final class MonitoringModePreferenceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "monitoring-mode-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func test誰も選んでいなければ空のまま() {
        // Not "paused": on a first run, and on an upgrade from a version that
        // never wrote this, the agent has to ask macOS what is actually
        // running rather than invent an answer.
        XCTAssertNil(MonitoringModePreference(defaults: defaults).storedMode)
    }

    func test選んだモードが残る() {
        let preference = MonitoringModePreference(defaults: defaults)
        preference.storedMode = "full"
        XCTAssertEqual(MonitoringModePreference(defaults: defaults).storedMode, "full")
    }

    func test選び直すと上書きされる() {
        let preference = MonitoringModePreference(defaults: defaults)
        preference.storedMode = "full"
        preference.storedMode = "paused"
        XCTAssertEqual(preference.storedMode, "paused")
    }

    func test消せる() {
        let preference = MonitoringModePreference(defaults: defaults)
        preference.storedMode = "full"
        preference.storedMode = nil
        XCTAssertNil(preference.storedMode)
    }

    func test空文字は選択として扱わない() {
        let preference = MonitoringModePreference(defaults: defaults)
        defaults.set("", forKey: MonitoringModePreference.key)
        XCTAssertNil(preference.storedMode)
    }

    func test再起動をまたいで残る() {
        // The whole point: the setting outlives the process that wrote it.
        MonitoringModePreference(defaults: defaults).storedMode = "full"
        XCTAssertEqual(MonitoringModePreference(defaults: defaults).storedMode, "full")
    }
}
