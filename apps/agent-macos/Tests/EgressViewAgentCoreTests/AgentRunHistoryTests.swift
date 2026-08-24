import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentRunHistoryTests: XCTestCase {
    private let base = Date(timeIntervalSince1970: 1_800_000_000)

    func testARunThatNeverSaidGoodbyeIsAnUnexpectedEnding() {
        // The whole mechanism: nothing is written at the moment of the crash,
        // because at that moment there is nothing left to write it. The next
        // launch reads the absence.
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.heartbeat(at: base.addingTimeInterval(3_600), lastObservationAt: nil)
        history.beginRun(at: base.addingTimeInterval(7_200), build: "96")

        let unexpected = history.unexpectedEndings()
        XCTAssertEqual(unexpected.count, 1)
        XCTAssertEqual(unexpected.first?.build, "95")
        XCTAssertEqual(unexpected.first?.knownDuration, 3_600)
    }

    func testACleanShutdownIsNotCountedAsACrash() {
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.endRun(at: base.addingTimeInterval(600))
        history.beginRun(at: base.addingTimeInterval(1_200), build: "95")

        XCTAssertTrue(history.unexpectedEndings().isEmpty)
        XCTAssertEqual(history.runs.first?.resolvedEnding, .clean)
    }

    func testKnownDurationIsALowerBoundAfterAnUnexpectedEnding() {
        // It died somewhere after the last heartbeat. How long after is not
        // knowable from here, and the report says "at least".
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.heartbeat(at: base.addingTimeInterval(120), lastObservationAt: nil)
        history.beginRun(at: base.addingTimeInterval(9_999), build: "95")

        XCTAssertEqual(history.runs.first?.knownDuration, 120)
    }

    func testSilenceBeforeTheEndSeparatesTwoDifferentFaults() {
        // A run recording until the moment it died, and a run that had gone
        // quiet hours earlier, are the same length and completely different
        // problems. 2026-08-18 was the second kind.
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.heartbeat(
            at: base.addingTimeInterval(50_000),
            lastObservationAt: base.addingTimeInterval(1_400)
        )
        history.beginRun(at: base.addingTimeInterval(60_000), build: "95")

        XCTAssertEqual(history.unexpectedEndings().first?.silenceBeforeEnd, 48_600)
    }

    func testARunThatRecordedNothingReportsNoSilenceRatherThanZero() {
        // Zero would read as "it was recording right up to the end".
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.beginRun(at: base.addingTimeInterval(60), build: "95")
        XCTAssertNil(history.runs.first?.silenceBeforeEnd)
    }

    func testTheHistoryIsBounded() {
        var history = AgentRunHistory()
        for i in 0..<(AgentRunHistory.limit + 5) {
            history.beginRun(at: base.addingTimeInterval(Double(i) * 60), build: "\(i)")
        }
        XCTAssertEqual(history.runs.count, AgentRunHistory.limit)
        XCTAssertEqual(history.runs.first?.build, "5")
    }

    func testSurvivesBeingWrittenAndReadBack() throws {
        // Dates are encoded ISO 8601 and must be decoded the same way; a
        // mismatch would lose every previous run at the moment they matter.
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("runs-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: url) }

        let recorder = AgentRunRecorder(fileURL: url)
        recorder.beginRun(at: base, build: "95")
        recorder.heartbeat(
            at: base.addingTimeInterval(60), lastObservationAt: base.addingTimeInterval(30)
        )

        let reopened = AgentRunRecorder(fileURL: url)
        reopened.beginRun(at: base.addingTimeInterval(120), build: "96")
        let unexpected = reopened.snapshot().unexpectedEndings()
        XCTAssertEqual(unexpected.count, 1)
        XCTAssertEqual(unexpected.first?.build, "95")
        XCTAssertEqual(
            unexpected.first?.lastObservationAt?.timeIntervalSince1970,
            base.addingTimeInterval(30).timeIntervalSince1970
        )
    }

    func testTheReportNamesTheEndingWithoutCallingItACrash() {
        // A force quit, a crash and a machine that lost power are the same
        // thing from here. Naming one would be a guess presented as a finding.
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        history.heartbeat(
            at: base.addingTimeInterval(7_200), lastObservationAt: base.addingTimeInterval(600)
        )
        history.beginRun(at: base.addingTimeInterval(7_500), build: "95")

        let stamp = ISO8601DateFormatter()
        stamp.formatOptions = [.withInternetDateTime]
        let text = AgentDiagnosticsReport.renderRuns(history) {
            $0.map { stamp.string(from: $0) } ?? "never"
        }.joined(separator: "\n")

        XCTAssertTrue(text.contains("ended unexpectedly"), text)
        XCTAssertTrue(text.contains("at least 2h 0m"), text)
        XCTAssertTrue(text.contains("silent before end"), text)
        XCTAssertFalse(text.lowercased().contains("crashed"), text)
    }

    func testTheFirstRunSaysSoRatherThanReportingZeroCrashes() {
        // "0 unexpected endings" out of no history is not reassurance, it is
        // an absence of evidence, and reads as the opposite.
        var history = AgentRunHistory()
        history.beginRun(at: base, build: "95")
        let text = AgentDiagnosticsReport.renderRuns(history) { _ in "never" }
            .joined(separator: "\n")
        XCTAssertTrue(text.contains("first run"), text)
    }
}
