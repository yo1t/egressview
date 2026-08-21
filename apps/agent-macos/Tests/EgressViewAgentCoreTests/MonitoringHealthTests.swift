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

    func test_直近の観測はExtension問い合わせを不要にする() {
        XCTAssertTrue(MonitoringHealthCheck.hasRecentObservation(recording, now: now))
    }

    func test_閾値に達した観測はExtension問い合わせが必要() {
        let boundary = now.addingTimeInterval(-MonitoringHealthCheck.silenceThreshold)
        XCTAssertFalse(MonitoringHealthCheck.hasRecentObservation(boundary, now: now))
    }

    func test_観測が無ければExtension問い合わせが必要() {
        XCTAssertFalse(MonitoringHealthCheck.hasRecentObservation(nil, now: now))
    }

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

    // MARK: - Silence with no update to blame
    //
    // The state that actually happened: on 2026-08-18 this Mac recorded nothing
    // between 09:28 and 22:55 -- confirmed absent on the Hub too, so collection
    // stopped rather than storage failing -- while the extension versions
    // matched and every check returned `healthy`.

    private var longAwake: Date { now.addingTimeInterval(-7200) }

    func test_起きたまま30分以上何も記録していなければ異常() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: now.addingTimeInterval(-3600),
            awakeSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .silentWhileActive(since: now.addingTimeInterval(-3600)))
    }

    func test_直近に記録があれば健全() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: recording,
            awakeSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    /// A sleeping Mac records nothing by design, and the last observation is
    /// always old for a moment after waking. Counting that as a fault would
    /// fire an alarm every single morning.
    func test_復帰直後は古い観測でも異常としない() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: now.addingTimeInterval(-28800),
            awakeSince: now.addingTimeInterval(-120),
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    /// Awake for hours, but the last observation is from before the sleep.
    /// Silence is counted from the wake, so this is still an outage.
    func test_復帰から30分経てばスリープ前の観測では健全と言わない() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: now.addingTimeInterval(-28800),
            awakeSince: now.addingTimeInterval(-3600),
            now: now
        )
        XCTAssertEqual(result, .silentWhileActive(since: now.addingTimeInterval(-28800)))
    }

    /// Nothing ever recorded, and running long enough that something should
    /// have been.
    func test_一度も記録がなければ監視開始時刻を沈黙の起点にする() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: nil,
            awakeSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .silentWhileActive(since: longAwake))
    }

    /// The agent's own first half hour is covered by the same guard: it has no
    /// silence to measure yet.
    func test_起動直後は沈黙を測らない() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: nil,
            awakeSince: now.addingTimeInterval(-60),
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    /// `awakeSince` is only known once monitoring has started. Without it there
    /// is nothing to measure against, and guessing would report every launch as
    /// an outage.
    func test_稼働開始時刻が不明なら沈黙を判定しない() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("30")],
            appBundleVersion: "30",
            lastObservationAt: now.addingTimeInterval(-86400),
            awakeSince: nil,
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    /// A pending swap is the better explanation and keeps its own wording. This
    /// pins the order so the vaguer verdict cannot take over the specific one.
    func test_入れ替え待ちが優先され再起動として報告される() {
        let result = MonitoringHealthCheck.evaluate(
            versions: [version("29", uninstalling: true), version("30", enabled: false)],
            appBundleVersion: "30",
            lastObservationAt: now.addingTimeInterval(-3600),
            awakeSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .rebootRequiredAfterUpdate(installed: "30", running: nil))
    }

    func test_macOSが応答しなくても長時間無記録なら異常() {
        let result = MonitoringHealthCheck.evaluateSilenceWithoutExtensionState(
            lastObservationAt: now.addingTimeInterval(-3600),
            monitoringSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .silentWhileActive(since: now.addingTimeInterval(-3600)))
    }

    func test_macOSが応答しなくても直近の観測があれば健全() {
        let result = MonitoringHealthCheck.evaluateSilenceWithoutExtensionState(
            lastObservationAt: recording,
            monitoringSince: longAwake,
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }

    func test_macOSが応答せず監視開始直後でも誤報しない() {
        let result = MonitoringHealthCheck.evaluateSilenceWithoutExtensionState(
            lastObservationAt: nil,
            monitoringSince: now.addingTimeInterval(-60),
            now: now
        )
        XCTAssertEqual(result, .healthy)
    }
}
