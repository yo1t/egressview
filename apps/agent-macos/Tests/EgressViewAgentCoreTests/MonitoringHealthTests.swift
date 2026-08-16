import XCTest
@testable import EgressViewAgentCore

final class MonitoringHealthTests: XCTestCase {
    private func version(
        _ build: String,
        enabled: Bool = true,
        awaiting: Bool = false,
        uninstalling: Bool = false
    ) -> SystemExtensionVersion {
        SystemExtensionVersion(
            shortVersion: "0.3.0",
            bundleVersion: build,
            isEnabled: enabled,
            isAwaitingUserApproval: awaiting,
            isUninstalling: uninstalling
        )
    }

    private let now = Date(timeIntervalSince1970: 1_700_000_000)
    private var silent: Date { now.addingTimeInterval(-600) }
    private var recording: Date { now.addingTimeInterval(-5) }

    func test_単一の有効なExtensionがアプリと一致すれば健全() {
        XCTAssertEqual(
            MonitoringHealthCheck.evaluate(versions: [version("30")], appBundleVersion: "30"),
            .healthy
        )
    }

    /// The state that lost data four times: the new copy is activated and
    /// enabled, and the old copy is waiting to uninstall on reboot. Everything
    /// looks fine and nothing is collected.
    func test_旧Extensionが再起動待ちで記録も止まっていれば再起動が必要() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [
                version("29", enabled: false, uninstalling: true),
                version("30"),
            ],
            appBundleVersion: "30",
            lastObservationAt: silent,
            now: now
        )
        XCTAssertEqual(result, .rebootRequiredAfterUpdate(installed: "30", running: "30"))
    }

    /// Measured on the real machine: the same pending-uninstall state, and
    /// collection carried on regardless. Warning here would cry wolf on every
    /// update that worked.
    func test_再起動待ちでも記録が続いていれば健全とみなす() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [
                version("30", enabled: false, uninstalling: true),
                version("31"),
            ],
            appBundleVersion: "31",
            lastObservationAt: recording,
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    func test_観測がまだ1件も無い場合は静止として扱う() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30", enabled: false, uninstalling: true), version("31")],
            appBundleVersion: "31",
            lastObservationAt: nil,
            now: now
        )
        XCTAssertEqual(result, .rebootRequiredAfterUpdate(installed: "31", running: "31"))
    }

    func test_動いているExtensionがアプリより古ければ再起動が必要() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("29")], appBundleVersion: "30",
            lastObservationAt: silent, now: now
        )
        XCTAssertEqual(result, .rebootRequiredAfterUpdate(installed: "30", running: "29"))
    }

    func test_有効なExtensionが1つも無ければ動いている版はnil() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30", enabled: false)], appBundleVersion: "30",
            lastObservationAt: silent, now: now
        )
        XCTAssertEqual(result, .rebootRequiredAfterUpdate(installed: "30", running: nil))
    }

    func test_承認待ちは再起動ではなく承認として報告する() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30", enabled: false, awaiting: true)],
            appBundleVersion: "30"
        )
        XCTAssertEqual(result, .awaitingApproval)
    }

    func test_未インストールは健全でも再起動でもない() {
        XCTAssertEqual(
            MonitoringHealthCheck.evaluate(versions: [], appBundleVersion: "30"),
            .notInstalled
        )
    }
}
