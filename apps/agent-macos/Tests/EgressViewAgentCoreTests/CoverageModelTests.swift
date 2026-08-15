import XCTest
@testable import EgressViewAgentCore

final class CoverageModelTests: XCTestCase {
    private let from = Date(timeIntervalSince1970: 1_000_000)
    private var to: Date { from.addingTimeInterval(3600) }

    private func at(_ minutes: Double) -> Date {
        from.addingTimeInterval(minutes * 60)
    }

    func test_期間全体をまたぐセッションは完全なcoverage() {
        let summary = CoverageCalculator.summarize(
            sessions: [CoverageSession(start: at(-60), end: at(120))],
            from: from, to: to
        )
        XCTAssertTrue(summary.isComplete)
        XCTAssertTrue(summary.gaps.isEmpty)
        XCTAssertFalse(summary.startedInsidePeriod)
    }

    func test_セッションが無ければcoverageは0で期間全体が欠落() {
        let summary = CoverageCalculator.summarize(sessions: [], from: from, to: to)
        XCTAssertTrue(summary.isEmpty)
        XCTAssertNil(summary.firstCovered)
        XCTAssertEqual(summary.gaps.count, 1)
        XCTAssertEqual(summary.gaps.first?.duration, 3600)
    }

    func test_期間の途中で開始したら開始時刻と欠落を報告する() {
        let summary = CoverageCalculator.summarize(
            sessions: [CoverageSession(start: at(30), end: at(120))],
            from: from, to: to
        )
        XCTAssertEqual(summary.share, 0.5, accuracy: 0.001)
        XCTAssertEqual(summary.firstCovered, at(30))
        XCTAssertTrue(summary.startedInsidePeriod)
        XCTAssertEqual(summary.gaps.first?.duration, 1800)
    }

    /// The update outage: monitoring ran, stopped, and ran again after a
    /// restart. The hole in the middle is the whole point of this type.
    func test_中断は欠落として残る() {
        let summary = CoverageCalculator.summarize(
            sessions: [
                CoverageSession(start: at(-10), end: at(15)),
                CoverageSession(start: at(45), end: at(70)),
            ],
            from: from, to: to
        )
        XCTAssertEqual(summary.share, 0.5, accuracy: 0.001)
        XCTAssertEqual(summary.gaps.count, 1)
        XCTAssertEqual(summary.gaps.first?.start, at(15))
        XCTAssertEqual(summary.gaps.first?.end, at(45))
    }

    func test_ごく短い中断は報告しない() {
        let summary = CoverageCalculator.summarize(
            sessions: [
                CoverageSession(start: at(-10), end: at(30)),
                CoverageSession(start: from.addingTimeInterval(30 * 60 + 5), end: at(120)),
            ],
            from: from, to: to
        )
        XCTAssertTrue(summary.gaps.isEmpty, "5秒の再起動を記録の穴として報告しない")
        XCTAssertLessThan(summary.share, 1)
    }

    func test_未終了のセッションはnowまでで打ち切り未来へ伸ばさない() {
        let summary = CoverageCalculator.summarize(
            sessions: [CoverageSession(start: from, end: nil)],
            from: from, to: to, now: at(30)
        )
        XCTAssertEqual(summary.share, 0.5, accuracy: 0.001)
        XCTAssertEqual(summary.gaps.first?.start, at(30))
    }

    func test_重なったセッションを二重に数えない() {
        let summary = CoverageCalculator.summarize(
            sessions: [
                CoverageSession(start: from, end: at(40)),
                CoverageSession(start: at(20), end: at(30)),
            ],
            from: from, to: to
        )
        XCTAssertEqual(summary.share, 40.0 / 60.0, accuracy: 0.001)
    }
}

final class CoverageStoreTests: XCTestCase {
    private func makeStore() throws -> (ObservationStore, URL) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("coverage-\(UUID().uuidString).sqlite")
        return (try ObservationStore(fileURL: url), url)
    }

    func test_開始と終了が往復する() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let start = Date(timeIntervalSince1970: 1_000_000)
        try store.beginCoverageSession(at: start)
        try store.endCoverageSession(at: start.addingTimeInterval(600))

        let sessions = try store.coverageSessions(
            from: start.addingTimeInterval(-60), to: start.addingTimeInterval(3600)
        )
        XCTAssertEqual(sessions.count, 1)
        XCTAssertEqual(
            try XCTUnwrap(sessions.first).start.timeIntervalSince1970,
            start.timeIntervalSince1970,
            accuracy: 0.001
        )
        XCTAssertEqual(
            try XCTUnwrap(sessions.first?.end).timeIntervalSince1970,
            start.timeIntervalSince1970 + 600,
            accuracy: 0.001
        )
    }

    func test_未終了のセッションはendがnilのまま返る() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let start = Date(timeIntervalSince1970: 1_000_000)
        try store.beginCoverageSession(at: start)

        let sessions = try store.coverageSessions(from: start, to: start.addingTimeInterval(3600))
        XCTAssertEqual(sessions.count, 1)
        XCTAssertNil(sessions.first?.end)
    }

    /// A crashed run must not keep claiming coverage forever.
    func test_前回開きっぱなしのセッションは次の開始時に閉じられる() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let first = Date(timeIntervalSince1970: 1_000_000)
        try store.beginCoverageSession(at: first)
        try store.beginCoverageSession(at: first.addingTimeInterval(7200))

        let sessions = try store.coverageSessions(
            from: first.addingTimeInterval(-60), to: first.addingTimeInterval(10800)
        )
        XCTAssertEqual(sessions.count, 2)
        XCTAssertNotNil(sessions.first?.end, "前回のセッションは閉じられている")
        XCTAssertNil(sessions.last?.end)
    }

    func test_期間外のセッションは返らない() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let start = Date(timeIntervalSince1970: 1_000_000)
        try store.beginCoverageSession(at: start)
        try store.endCoverageSession(at: start.addingTimeInterval(60))

        let sessions = try store.coverageSessions(
            from: start.addingTimeInterval(3600), to: start.addingTimeInterval(7200)
        )
        XCTAssertTrue(sessions.isEmpty)
    }
}
