import XCTest
@testable import EgressViewAgentCore
import EgressViewAgentUI

/// The list asks "does this differ from this Mac's own usual level", and says
/// when it cannot tell (P3-192, P3-193 phase 2).
final class OutboundCandidatesTests: XCTestCase {
    private typealias Rules = OutboundCandidateRules
    private let day0: Double = 1_699_920_000
    private let mib: UInt64 = 1 << 20
    private let pair = OutboundCandidateRules.PairKey(application: "curl", destination: "one.example")

    /// `days` of fully monitored hours, a quiet megabyte each.
    private func hours(days: Int, bytes: UInt64 = 1 << 20, withBytes: Int = 99) -> [Rules.Hour] {
        (0..<(days * 24)).map {
            Rules.Hour(
                start: day0 + Double($0) * 3600, monitoredSeconds: 3600, bytesOut: bytes,
                observations: 100, observationsWithBytes: withBytes
            )
        }
    }

    private func day(_ n: Int) -> Double { day0 + Double(n) * 86_400 }

    private func now(_ n: Int) -> Date { Date(timeIntervalSince1970: day(n)) }

    private func evaluate(
        hours: [Rules.Hour], days: [Rules.PairDay] = [], firstSeen: [Rules.PairKey: Double] = [:], now: Date
    ) -> OutboundCandidateReport {
        Rules.evaluate(hours: hours, pairDays: days, firstSeen: firstSeen, now: now)
    }

    func testLearningIsCountedInMonitoredHoursNotCalendarDays() {
        let sleepy = (0..<40).map {
            Rules.Hour(start: day0 + Double($0) * 86_400, monitoredSeconds: 3600, bytesOut: 1)
        }
        let report = evaluate(hours: sleepy, now: now(40))
        XCTAssertEqual(report.state, .learning(monitoredHours: 40))
        XCTAssertTrue(report.candidates.isEmpty)
    }

    func testANewPairIsFoundByWhatItAddsUpToOverAWeek() {
        let days = (8..<12).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: 300 << 10) }
        let report = evaluate(hours: hours(days: 12), days: days, firstSeen: [pair: day(8)], now: now(12))
        XCTAssertEqual(report.candidates.map(\.kind), [.newPair])
        XCTAssertEqual(report.candidates.first?.at, Date(timeIntervalSince1970: day(11)))
    }

    func testANewPairUnderAMegabyteInAWeekIsNotListed() {
        let days = (8..<15).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: 100 << 10) }
        let report = evaluate(hours: hours(days: 15), days: days, firstSeen: [pair: day(8)], now: now(15))
        XCTAssertTrue(report.candidates.isEmpty)
    }

    func testAPairSeenWhileLearningIsNotNew() {
        let days = [Rules.PairDay(day: day(9), pair: pair, bytesOut: 5 * mib)]
        let report = evaluate(hours: hours(days: 10), days: days, firstSeen: [pair: day(2)], now: now(10))
        XCTAssertTrue(report.candidates.isEmpty)
    }

    func testBrowsersAndVirtualMachinesAreNotNewPairs() {
        for application in ["Google Chrome Helper (Aperitif)", "vmnet-natd", "com.apple.WebKit.Networking", "Arc"] {
            let key = Rules.PairKey(application: application, destination: "one.example")
            let days = [Rules.PairDay(day: day(9), pair: key, bytesOut: 5 * mib)]
            let report = evaluate(hours: hours(days: 10), days: days, firstSeen: [key: day(9)], now: now(10))
            XCTAssertTrue(report.candidates.isEmpty, application)
        }
    }

    func testNamesThatOnlyContainABrowserWordAreStillJudged() {
        for application in ["siriknowledged", "Archive Utility", "searchd"] {
            XCTAssertFalse(Rules.isUnattributable(application: application), application)
        }
    }

    func testAKnownPairFarAboveItsOwnUsualDayIsListed() {
        var days = (0..<8).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: mib) }
        days.append(Rules.PairDay(day: day(8), pair: pair, bytesOut: 20 * mib))
        let report = evaluate(hours: hours(days: 9), days: days, firstSeen: [pair: day(0)], now: now(9))
        XCTAssertEqual(report.candidates.map(\.kind), [.aboveUsual])
        XCTAssertEqual(report.candidates.first?.usualBytesOut, mib)
    }

    func testABusyPairInsideItsOwnRangeIsNotListed() {
        let days = (0..<9).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: 60 * mib) }
        let report = evaluate(hours: hours(days: 9), days: days, firstSeen: [pair: day(0)], now: now(9))
        XCTAssertTrue(report.candidates.isEmpty)
    }

    func testOneBigDayDoesNotRaiseTheYardstickForTheNext() {
        var days = (0..<8).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: mib) }
        days.append(Rules.PairDay(day: day(8), pair: pair, bytesOut: 8_000 * mib))
        days.append(Rules.PairDay(day: day(9), pair: pair, bytesOut: 20 * mib))
        let report = evaluate(hours: hours(days: 10), days: days, firstSeen: [pair: day(0)], now: now(10))
        XCTAssertEqual(report.candidates.count, 2)
    }

    func testTheMachineIsListedOncePerDayForItsLargestWindow() {
        var all = hours(days: 12)
        all[10 * 24 + 5].bytesOut = 500 * mib
        let report = evaluate(hours: all, now: now(12))
        let machine = report.candidates.filter { $0.kind == .machine }
        XCTAssertFalse(machine.isEmpty)
        XCTAssertEqual(Set(machine.map(\.at)).count, machine.count)
        XCTAssertEqual(machine.map(\.bytesOut).max(), 523 * mib)
    }

    func testAnEvenMachineIsNotListed() {
        XCTAssertTrue(evaluate(hours: hours(days: 14), now: now(14)).candidates.isEmpty)
    }

    func testLowByteCoverageIsSaidEvenWhenTheListIsEmpty() {
        let report = evaluate(hours: hours(days: 9, withBytes: 19), now: now(9))
        XCTAssertEqual(report.state, .lowByteCoverage(share: 0.19))
    }

    func testOnlyTheLastFourteenDaysAreListed() {
        let days = [Rules.PairDay(day: day(9), pair: pair, bytesOut: 5 * mib)]
        let report = evaluate(hours: hours(days: 10), days: days, firstSeen: [pair: day(9)], now: now(24))
        XCTAssertTrue(report.candidates.isEmpty)
    }

    func testAListOverTheLimitKeepsTheNewestAndCountsThemAll() {
        let pairs = (0..<(Rules.listLimit + 5)).map {
            Rules.PairKey(application: "tool\($0)", destination: "one.example")
        }
        let days = pairs.map { Rules.PairDay(day: day(9), pair: $0, bytesOut: 5 * mib) }
        let firstSeen = Dictionary(uniqueKeysWithValues: pairs.map { ($0, day(9)) })
        let report = evaluate(hours: hours(days: 10), days: days, firstSeen: firstSeen, now: now(10))
        XCTAssertEqual(report.candidates.count, Rules.listLimit)
        XCTAssertEqual(report.total, Rules.listLimit + 5)
    }

    func testTheTileSummaryNeverReadsAsAllClearWhenItCannotTell() {
        // Compared with each other, because the words follow the app's language.
        let summary = AgentOutboundCandidatesView.summary
        let allClear = summary(OutboundCandidateReport(state: .ready))
        XCTAssertNotEqual(summary(OutboundCandidateReport(state: .learning(monitoredHours: 41.5))), allClear,
                          "判定できないのに異常なしと読めてはいけない")
        XCTAssertNotEqual(summary(OutboundCandidateReport(state: .lowByteCoverage(share: 0.19))), allClear,
                          "判定できないのに異常なしと読めてはいけない")
        XCTAssertNotEqual(
            summary(OutboundCandidateReport(state: .lowByteCoverage(share: 0.19), total: 3)),
            summary(OutboundCandidateReport(state: .ready, total: 3)),
            "取得率が低いときは件数だけで終わらない"
        )
    }

    func testTheTileSummaryGivesTheWholeCountNotTheListedOne() {
        let report = OutboundCandidateReport(state: .ready, candidates: [], total: 60)
        XCTAssertTrue(AgentOutboundCandidatesView.summary(report).contains("60"))
    }
}
