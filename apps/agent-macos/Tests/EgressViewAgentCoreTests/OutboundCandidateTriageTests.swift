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
}
