import XCTest
@testable import EgressViewAgentCore

final class AgentDiagnosticsReportTests: XCTestCase {
    private func inputs(installLog: String? = nil) -> AgentDiagnosticsReport.Inputs {
        AgentDiagnosticsReport.Inputs(
            generatedAt: Date(timeIntervalSince1970: 1_770_000_000),
            appVersion: "0.5.29",
            appBuild: "91",
            osVersion: "15.2",
            extensionState: "running",
            extensionVersion: "0.5.29",
            monitoringEnabled: true,
            health: "healthy",
            lastObservationAt: Date(timeIntervalSince1970: 1_769_999_000),
            storage: ObservationStorageSummary(
                rawObservationCount: 12_345,
                rolledUpHourCount: 720,
                threatIndicatorCount: 40_000,
                oldestObservationAt: Date(timeIntervalSince1970: 1_768_000_000),
                newestObservationAt: Date(timeIntervalSince1970: 1_769_999_000)
            ),
            isEnrolledWithHub: false,
            deliveryEnabled: false,
            pendingDeliveryCount: 0,
            oldestPendingAt: nil,
            lastAcknowledgedAt: nil,
            unreadableStateResetAt: nil,
            threatIntelSource: "directDownload",
            installLogTail: installLog
        )
    }

    func testReportCarriesNoTrafficOfTheUsers() {
        // The whole point. A tool that watches what leaves a machine must not
        // be the thing that carries it out.
        let text = AgentDiagnosticsReport(inputs()).render()
        for forbidden in ["93.184.216.34", "example.com", "Safari", "firefox"] {
            XCTAssertFalse(text.contains(forbidden))
        }
        // Nothing in the inputs can hold one either: the storage summary is
        // counts and dates, which is what makes the line above more than a
        // spot check.
        XCTAssertEqual(
            String(describing: ObservationStorageSummary.self), "ObservationStorageSummary"
        )
    }

    func testStatesUpFrontWhatItDoesNotContain() {
        // A person is asked to send this file. They should be able to see the
        // claim, and then check it, without reading to the end.
        let text = AgentDiagnosticsReport(inputs()).render()
        let head = text.split(separator: "\n").prefix(6).joined(separator: "\n")
        XCTAssertTrue(head.contains("no destination address, process name or host name"))
    }

    func testAccountNamesAreRemovedFromTheInstallLog() {
        // The installer records the console user, and an account name is not
        // needed to diagnose a failed relaunch.
        let log = """
        console user: yoichi
        launchctl asuser 501 open -a /Applications/EgressView Agent.app
        copied from /Users/yoichi/Downloads/egressview-agent-0.5.29.pkg
        """
        let redacted = AgentDiagnosticsReport.redactAccountNames(log)
        XCTAssertFalse(redacted.contains("yoichi"))
        XCTAssertFalse(redacted.contains("501"))
        XCTAssertTrue(redacted.contains("/Users/<redacted>"))
        // What the log is for must survive the redaction.
        XCTAssertTrue(redacted.contains("egressview-agent-0.5.29.pkg"))
        XCTAssertTrue(redacted.contains("EgressView Agent.app"))
    }

    func testInstallLogIsBounded() {
        // A report nobody reads is a report nobody checks before sending.
        let long = (1...500).map { "line \($0)" }.joined(separator: "\n")
        let prepared = AgentDiagnosticsReport.prepareInstallLog(long)
        let lines = prepared?.split(separator: "\n") ?? []
        XCTAssertEqual(lines.count, AgentDiagnosticsReport.installLogLineLimit)
        // The tail is what matters: the most recent install is the one that
        // preceded the fault.
        XCTAssertEqual(lines.last, "line 500")
    }

    func testSaysSoWhenThereIsNoInstallLog() {
        // An absent log and an unread log look the same to a reader unless the
        // report distinguishes them.
        let text = AgentDiagnosticsReport(inputs(installLog: nil)).render()
        XCTAssertTrue(text.contains("/var/log/egressview-agent-install.log is absent or empty"))
    }

    func testReportsTheFieldsThatWouldHaveNarrowedTheOutage() {
        // Each of these exists because 2026-08-18 could not be diagnosed
        // without it.
        let text = AgentDiagnosticsReport(inputs()).render()
        for required in ["agent", "build 91", "extension", "health", "last observation"] {
            XCTAssertTrue(text.contains(required), "missing \(required)")
        }
    }
}
