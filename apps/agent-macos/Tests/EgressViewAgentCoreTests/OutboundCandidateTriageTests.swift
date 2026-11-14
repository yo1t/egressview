import XCTest
@testable import EgressViewAgentCore

/// A candidate opens to the connections behind it, and the person's answer is
/// kept apart from it, on this Mac only (P3-194 phase 1).
final class OutboundCandidateTriageTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!

    /// A UTC midnight, as the baseline's days are.
    private let day = Date(timeIntervalSince1970: 1_699_920_000)
    private let mib: UInt64 = 1 << 20

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("triage-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(
        at date: Date, address: String = "203.0.113.7", hostname: String? = "api.one.example",
        process: String = "curl", bytesOut: UInt64? = 1_000
    ) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 50_000,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: bytesOut, collector: .networkExtension,
            confidence: .exact, remoteHostname: hostname
        )])
    }

    private func candidate(
        _ kind: OutboundCandidate.Kind = .aboveUsual, application: String? = "curl",
        destination: String? = "one.example", at: Date? = nil
    ) -> OutboundCandidate {
        OutboundCandidate(
            kind: kind, at: at ?? day, application: application, destination: destination,
            bytesOut: 12 * mib, usualBytesOut: kind == .newPair ? nil : mib
        )
    }

    func test版20で判断の表ができる() throws {
        XCTAssertEqual(store.schemaVersion(), ObservationStore.latestSchemaVersion)
        XCTAssertEqual(ObservationStore.latestSchemaVersion, 20)
        XCTAssertTrue(try store.outboundCandidateJudgments().isEmpty)
    }

    func test判断は候補と別に残り上書きと取り消しができる() throws {
        let item = candidate()
        try store.setOutboundCandidateJudgment(
            item, verdict: .expected, note: "自分のバックアップ", now: day.addingTimeInterval(3600)
        )
        var judgments = try store.outboundCandidateJudgments()
        XCTAssertEqual(judgments[item.id]?.verdict, .expected)
        XCTAssertEqual(judgments[item.id]?.note, "自分のバックアップ")
        XCTAssertEqual(judgments[item.id]?.candidateAt, day)

        try store.setOutboundCandidateJudgment(item, verdict: .investigate, note: "")
        judgments = try store.outboundCandidateJudgments()
        XCTAssertEqual(judgments.count, 1)
        XCTAssertEqual(judgments[item.id]?.verdict, .investigate)

        try store.setOutboundCandidateJudgment(item, verdict: nil)
        XCTAssertTrue(try store.outboundCandidateJudgments().isEmpty)
    }

    func testメモは長くても上限で切る() throws {
        let item = candidate()
        try store.setOutboundCandidateJudgment(item, verdict: .expected, note: String(repeating: "あ", count: 2_000))
        XCTAssertEqual(try store.outboundCandidateJudgments()[item.id]?.note.count, ObservationStore.judgmentNoteLimit)
    }

    func test再び開いても判断が残る() throws {
        let item = candidate()
        try store.setOutboundCandidateJudgment(item, verdict: .expected)
        store = nil
        store = try ObservationStore(fileURL: url)
        XCTAssertEqual(try store.outboundCandidateJudgments()[item.id]?.verdict, .expected)
    }

    func test根拠の通信は基準と同じ組だけを多い順に出す() throws {
        try observe(at: day.addingTimeInterval(600), hostname: "api.one.example", bytesOut: 3_000)
        try observe(at: day.addingTimeInterval(700), hostname: "api.one.example", bytesOut: 2_000)
        try observe(at: day.addingTimeInterval(7_200), address: "203.0.113.8", hostname: "cdn.one.example", bytesOut: 9_000)
        // Another app, another destination, the network itself, and the day after.
        try observe(at: day.addingTimeInterval(800), process: "other", bytesOut: 50_000)
        try observe(at: day.addingTimeInterval(900), hostname: "two.example", bytesOut: 50_000)
        try observe(at: day.addingTimeInterval(1_000), address: "192.168.1.20", hostname: "nas.one.example", bytesOut: 50_000)
        try observe(at: day.addingTimeInterval(86_400 + 60), bytesOut: 50_000)

        let evidence = try store.outboundCandidateEvidence(for: candidate())
        XCTAssertEqual(evidence.flows.map(\.hostname), ["cdn.one.example", "api.one.example"])
        XCTAssertEqual(evidence.flows.map(\.bytesOut), [9_000, 5_000])
        XCTAssertEqual(evidence.flows.last?.connections, 2)
        XCTAssertEqual(evidence.flowTotal, 2)
        XCTAssertEqual(evidence.bytesOut, 14_000)
        XCTAssertEqual(evidence.window, DateInterval(start: day, end: day.addingTimeInterval(86_400)))
    }

    func test根拠の通信は件数の上限で切り全体の数は残す() throws {
        for index in 0..<5 {
            try observe(at: day.addingTimeInterval(Double(index) * 60), address: "203.0.113.\(10 + index)",
                        hostname: nil, bytesOut: UInt64(1_000 * (index + 1)))
        }
        let evidence = try store.outboundCandidateEvidence(
            for: candidate(.machine, application: nil, destination: nil), limit: 2
        )
        XCTAssertEqual(evidence.flows.map(\.address), ["203.0.113.14", "203.0.113.13"])
        XCTAssertEqual(evidence.flowTotal, 5)
        XCTAssertEqual(evidence.bytesOut, 15_000)
    }

    func test新しい組は載るまでの1週間をさかのぼる() throws {
        let window = OutboundCandidateRules.evidenceWindow(for: candidate(.newPair))
        XCTAssertEqual(window.start, day.addingTimeInterval(-6 * 86_400))
        XCTAssertEqual(window.end, day.addingTimeInterval(86_400))
        try observe(at: day.addingTimeInterval(-5 * 86_400), bytesOut: 4_000)
        let evidence = try store.outboundCandidateEvidence(for: candidate(.newPair))
        XCTAssertEqual(evidence.bytesOut, 4_000)
    }

    func testこのMac全体はその日に終わる24時間をすべて含める() throws {
        let window = OutboundCandidateRules.evidenceWindow(for: candidate(.machine, application: nil, destination: nil))
        XCTAssertEqual(window.start, day.addingTimeInterval(-23 * 3600))
        XCTAssertEqual(window.end, day.addingTimeInterval(86_400))
    }

    func test監視していない時間があれば少なく見えるかもしれないと言う() throws {
        try observe(at: day.addingTimeInterval(600), bytesOut: 3_000)
        let unwatched = try store.outboundCandidateEvidence(for: candidate())
        XCTAssertEqual(unwatched.monitoredSeconds, 0)
        XCTAssertTrue(unwatched.mayUndercount)

        let full = OutboundCandidateEvidence(
            window: DateInterval(start: day, duration: 86_400), flows: [], flowTotal: 0, bytesOut: 0,
            monitoredSeconds: 86_400, byteShare: 1, rawHistoryIsPartial: false
        )
        XCTAssertFalse(full.mayUndercount)
        var noBytes = full
        noBytes.byteShare = 0.5
        XCTAssertTrue(noBytes.mayUndercount)
        var folded = full
        folded.rawHistoryIsPartial = true
        XCTAssertTrue(folded.mayUndercount)
    }

    func test履歴を消すと判断も消える() throws {
        let old = candidate(at: day)
        let recent = candidate(at: day.addingTimeInterval(3 * 86_400))
        try store.setOutboundCandidateJudgment(old, verdict: .expected)
        try store.setOutboundCandidateJudgment(recent, verdict: .investigate)

        try store.removeObservations(before: day.addingTimeInterval(86_400))
        XCTAssertEqual(Array(try store.outboundCandidateJudgments().keys), [recent.id])

        try store.removeAll()
        XCTAssertTrue(try store.outboundCandidateJudgments().isEmpty)
    }

    func test全部消すボタンは判断だけを消す() throws {
        try observe(at: day.addingTimeInterval(600))
        try store.setOutboundCandidateJudgment(candidate(), verdict: .expected)
        try store.removeAllOutboundCandidateJudgments()
        XCTAssertTrue(try store.outboundCandidateJudgments().isEmpty)
        XCTAssertEqual(try store.statistics().rawCount, 1)
    }

    func testAIに渡す一覧は答えとメモを候補に添える() throws {
        let answered = candidate()
        let open = candidate(.newPair, application: "zoom", destination: "zoom.us")
        let machine = candidate(.machine, application: nil, destination: nil)
        let report = OutboundCandidateReport(state: .ready, candidates: [answered, open, machine], total: 3)
        let judgments = [
            answered.id: OutboundCandidateJudgment(
                candidateID: answered.id, candidateAt: day, verdict: .expected, note: "  夜のバックアップ \n", judgedAt: day
            ),
            machine.id: OutboundCandidateJudgment(
                candidateID: machine.id, candidateAt: day, verdict: .investigate, note: "   ", judgedAt: day
            ),
        ]
        let list = AgentLocalInsightCandidateList(report: report, judgments: judgments)
        XCTAssertEqual(list.state, "ready")
        XCTAssertEqual(list.total, 3)
        XCTAssertEqual(list.entries.map(\.answer), ["expected", nil, "investigate"])
        XCTAssertEqual(list.entries.map(\.note), ["夜のバックアップ", nil, nil])
        XCTAssertEqual(list.entries.map(\.kind), ["aboveUsual", "newPair", "machine"])
        XCTAssertNil(list.entries[2].application)

        let learning = AgentLocalInsightCandidateList(
            report: OutboundCandidateReport(state: .learning(monitoredHours: 3)), judgments: [:]
        )
        XCTAssertEqual(learning.state, "learning")
        XCTAssertTrue(learning.entries.isEmpty)
    }

    func testAIに渡す一覧は件数の上限で切る() {
        let many = (0..<30).map { candidate(application: "app\($0)") }
        let list = AgentLocalInsightCandidateList(
            report: OutboundCandidateReport(state: .ready, candidates: many, total: 30), judgments: [:]
        )
        XCTAssertEqual(list.entries.count, AgentLocalInsightCandidateList.entryLimit)
        XCTAssertEqual(list.total, 30)
    }

    func test答えが変わるとAIに渡す内容もすぐ変わる() throws {
        let snapshot = try AgentLocalInsightBuilder.build(
            current: [], previous: [], periodStart: day, periodEnd: day.addingTimeInterval(3600)
        )
        XCTAssertNil(snapshot.context.outboundCandidates)
        let item = candidate()
        let list = AgentLocalInsightCandidateList(
            report: OutboundCandidateReport(state: .ready, candidates: [item], total: 1),
            judgments: [item.id: .init(candidateID: item.id, candidateAt: day, verdict: .expected, note: "メモ", judgedAt: day)]
        )
        let updated = try snapshot.replacingCandidates(list)
        XCTAssertEqual(updated.context.outboundCandidates, list)
        XCTAssertGreaterThan(updated.previewSizeBytes, snapshot.previewSizeBytes)
        let json = String(decoding: try updated.context.encodedPreview(), as: UTF8.self)
        XCTAssertTrue(json.contains("\"outboundCandidates\""))
        XCTAssertTrue(json.contains("メモ"))
        XCTAssertEqual(updated.context.schemaVersion, 2)
    }

    func test通知に添える答えは同じ組の一番新しいものでメモを含まない() throws {
        let earlier = candidate(at: day)
        let later = candidate(.newPair, at: day.addingTimeInterval(86_400))
        try store.setOutboundCandidateJudgment(earlier, verdict: .investigate, note: "a", now: day)
        try store.setOutboundCandidateJudgment(later, verdict: .expected, note: "秘密", now: day.addingTimeInterval(90_000))
        try store.setOutboundCandidateJudgment(
            candidate(application: "zoom", destination: "zoom.us"), verdict: .investigate, now: day.addingTimeInterval(99_000)
        )
        let answer = try XCTUnwrap(store.latestOutboundCandidateAnswer(application: "curl", destination: "one.example"))
        XCTAssertEqual(answer.verdict, .expected)
        XCTAssertEqual(answer.candidateID, later.id)
        XCTAssertEqual(answer.note, "")
        XCTAssertNil(try store.latestOutboundCandidateAnswer(application: "curl", destination: "two.example"))
    }

    func test窓で一番送った組を基準と同じ鍵で返す() throws {
        let window = day.addingTimeInterval(900)
        try observe(at: window.addingTimeInterval(10), hostname: "a.one.example", bytesOut: 4_000)
        try observe(at: window.addingTimeInterval(20), address: "203.0.113.9", hostname: "b.one.example", bytesOut: 3_000)
        try observe(at: window.addingTimeInterval(30), hostname: "zoom.us", process: "zoom", bytesOut: 5_000)
        try observe(at: window.addingTimeInterval(40), address: "192.168.1.20", hostname: "nas.local", bytesOut: 90_000)
        try observe(at: window.addingTimeInterval(1_000), bytesOut: 90_000)
        let top = try XCTUnwrap(store.outboundWindowTopPair(windowStart: window))
        XCTAssertEqual(top.application, "curl")
        XCTAssertEqual(top.destination, "one.example")
        XCTAssertEqual(top.bytesOut, 7_000)
        XCTAssertEqual(top.windowBytesOut, 12_000)
    }
}
