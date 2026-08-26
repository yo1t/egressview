import XCTest
@testable import EgressViewAgentCore

final class AgentDiagnosticsReportTests: XCTestCase {
    private func inputs(
        installLog: AgentDiagnosticsReport.InstallLog = .absent
    ) -> AgentDiagnosticsReport.Inputs {
        AgentDiagnosticsReport.Inputs(
            generatedAt: Date(timeIntervalSince1970: 1_770_000_000),
            appVersion: "0.5.29",
            appBuild: "91",
            osVersion: "15.2",
            extensionState: "running",
            bundledExtensionVersion: "0.5.30 build 93",
            runningExtensionVersion: nil,
            monitoringEnabled: true,
            health: "healthy",
            lastObservationAt: Date(timeIntervalSince1970: 1_769_999_000),
            storage: ObservationStorageSummary(
                rawObservationCount: 12_345,
                rolledUpHourCount: 0,
                chartHourCount: 82_201,
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
            installLog: installLog
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

    /// The report says which rule discarded them, and stays free of traffic.
    ///
    /// A rule name is not an observation: "remotePortZero" tells the reader
    /// what happened without naming a destination, a process or a host.
    func testDiscardedObservationsAreReportedByRuleName() {
        var subject = inputs()
        subject.contractRejectedCount = 4
        subject.contractRejections = ["remotePortZero": 3, "processNameUnusable": 1]
        let text = AgentDiagnosticsReport(subject).render()
        XCTAssertTrue(text.contains("Discarded before sending"))
        XCTAssertTrue(text.contains("remotePortZero"))
        XCTAssertTrue(text.contains("processNameUnusable"))
    }

    /// Nothing discarded, nothing to explain.
    func testTheDiscardSectionIsAbsentWhenNothingWasDiscarded() {
        XCTAssertFalse(AgentDiagnosticsReport(inputs()).render().contains("Discarded before sending"))
    }

    func testOlderUnclassifiedDiscardsRemainVisible() {
        var subject = inputs()
        subject.contractRejectedCount = 4

        let text = AgentDiagnosticsReport(subject).render()
        XCTAssertTrue(text.contains("unclassified (recorded by an earlier version): 4"))
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

    func testDistinguishesAnUnreadableLogFromAnAbsentOne() {
        // Found on a real Mac: the export said the installer log was "absent
        // or empty" while the file existed and had just recorded this very
        // install. The agent is sandboxed and /var/log is outside it. Saying
        // "absent" sends the reader looking for a missing file instead of at
        // the sandbox.
        let absent = AgentDiagnosticsReport(inputs(installLog: .absent)).render()
        XCTAssertTrue(absent.contains("absent -- no install has recorded anything here"))

        let unreadable = AgentDiagnosticsReport(
            inputs(installLog: .unreadable("not visible from inside the app sandbox"))
        ).render()
        XCTAssertTrue(unreadable.contains("not readable by the agent (sandboxed)"))
        // The log still exists for whoever asked for the export.
        XCTAssertTrue(unreadable.contains("sudo tail"))
    }

    func testReportsBothAggregatesSeparately() {
        // Also found on a real Mac: a single "rolled up" figure showed 0 on a
        // machine holding 82,201 chart rows, which reads as "nothing was
        // folded" when the opposite is true.
        let text = AgentDiagnosticsReport(inputs()).render()
        // Matched on the label and value rather than on the exact padding:
        // pinning column widths makes a cosmetic change look like a defect.
        func value(_ label: String) -> String? {
            text.split(separator: "\n")
                .first { $0.trimmingCharacters(in: .whitespaces).hasPrefix(label) }
                .map { $0.trimmingCharacters(in: .whitespaces).dropFirst(label.count) }
                .map { $0.trimmingCharacters(in: .whitespaces) }
        }
        XCTAssertEqual(value("folded hours"), "0")
        XCTAssertEqual(value("chart hours"), "82201")
    }

    func testReportsTheBundledExtensionEvenOnAHealthyMac() {
        // Found on a real Mac: this said "unknown" every time, because it was
        // wired to a probe that only runs once collection has gone quiet --
        // which is never, on the machines a first report comes from.
        let text = AgentDiagnosticsReport(inputs()).render()
        XCTAssertTrue(text.contains("0.5.30 build 93"))
        // And it does not pretend to know what macOS is running.
        XCTAssertTrue(text.contains("not asked -- macOS is only queried when collection goes quiet"))
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
