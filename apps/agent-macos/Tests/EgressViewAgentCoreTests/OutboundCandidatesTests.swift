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

    /// P3-194: a pair whose level really moved was listed every day, and
    /// answering "expected" changed nothing.
    func testADayAnsweredExpectedJoinsThePairsUsualLevel() {
        var days = (0..<8).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: mib) }
        days += (8..<12).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: 30 * mib) }
        let before = evaluate(hours: hours(days: 12), days: days, firstSeen: [pair: day(0)], now: now(12))
        XCTAssertEqual(before.candidates.count, 4, "unanswered, every raised day stays listed")

        // The yardstick is the 90th percentile, so one answered day does not
        // move it: a single expected burst is not a new level.
        let first = before.candidates.first { $0.at == now(8) }!
        let one = Rules.evaluate(
            hours: hours(days: 12), pairDays: days, firstSeen: [pair: day(0)], now: now(12),
            expected: [first.id]
        )
        XCTAssertEqual(one.candidates.count, 4)

        let second = before.candidates.first { $0.at == now(9) }!
        let two = Rules.evaluate(
            hours: hours(days: 12), pairDays: days, firstSeen: [pair: day(0)], now: now(12),
            expected: [first.id, second.id]
        )
        XCTAssertEqual(two.candidates.map(\.at), [now(9), now(8)], "the answered days stay listed, the rest are usual now")
        XCTAssertEqual(Set(two.candidates.map(\.id)), [first.id, second.id], "the ids do not move, so the answers stay attached")
    }

    func testAnswersOnOtherDaysOrOtherPairsDoNotRaiseTheUsualLevel() {
        let other = Rules.PairKey(application: "curl", destination: "two.example")
        var days = (0..<8).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: mib) }
        days += (8..<10).map { Rules.PairDay(day: day($0), pair: pair, bytesOut: 30 * mib) }
        days += (0..<8).map { Rules.PairDay(day: day($0), pair: other, bytesOut: mib) }
        days += (8..<10).map { Rules.PairDay(day: day($0), pair: other, bytesOut: 30 * mib) }
        let before = evaluate(
            hours: hours(days: 10), days: days, firstSeen: [pair: day(0), other: day(0)], now: now(10)
        )
        XCTAssertEqual(before.candidates.count, 4)
        let answered = before.candidates.first { $0.destination == "two.example" && $0.at == now(9) }!
        let after = Rules.evaluate(
            hours: hours(days: 10), pairDays: days, firstSeen: [pair: day(0), other: day(0)], now: now(10),
            expected: [answered.id, "aboveUsual|0.0|curl|one.example"]
        )
        XCTAssertEqual(after.candidates.count, 4, "an answer on the last day, or for a day never listed, moves nothing")
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
