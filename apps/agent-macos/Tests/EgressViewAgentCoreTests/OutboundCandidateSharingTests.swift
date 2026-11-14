import XCTest
@testable import EgressViewAgentCore

/// The "worth a look" list goes to the Hub only when the person turns it on,
/// and the note only with the second switch (P3-194).
final class OutboundCandidateSharingTests: XCTestCase {
    private let day = Date(timeIntervalSince1970: 1_699_920_000)

    private func report(_ candidates: [OutboundCandidate]) -> OutboundCandidateReport {
        OutboundCandidateReport(state: .ready, candidates: candidates, total: candidates.count)
    }

    private func candidate(application: String = "com.example.backup", destination: String = "example.net") -> OutboundCandidate {
        OutboundCandidate(
            kind: .aboveUsual, at: day, application: application, destination: destination,
            bytesOut: 9_500_000_000, usualBytesOut: 400_000_000
        )
    }

    private func judgment(_ item: OutboundCandidate, note: String) -> [String: OutboundCandidateJudgment] {
        [item.id: OutboundCandidateJudgment(
            candidateID: item.id, candidateAt: item.at, verdict: .expected, note: note,
            judgedAt: day.addingTimeInterval(3600)
        )]
    }

    private func json(_ payload: OutboundCandidateSharePayload) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: payload.encoded()) as? [String: Any])
    }

    func testメモは2つ目のスイッチを入れたときだけ送る() throws {
        let item = candidate()
        let judgments = judgment(item, note: "  自分のバックアップ  ")
        let without = OutboundCandidateSharePayload(report: report([item]), judgments: judgments, includesNotes: false)
        XCTAssertNil(without.entries[0].note)
        XCTAssertEqual(without.entries[0].answer, "expected")
        XCTAssertFalse(String(decoding: try without.encoded(), as: UTF8.self).contains("バックアップ"))

        let with = OutboundCandidateSharePayload(report: report([item]), judgments: judgments, includesNotes: true)
        XCTAssertEqual(with.entries[0].note, "自分のバックアップ")
    }

    func test候補IDはハッシュで送り元の名前を含めない() throws {
        let item = candidate()
        let payload = OutboundCandidateSharePayload(report: report([item]), judgments: [:], includesNotes: false)
        let id = payload.entries[0].candidateId
        XCTAssertEqual(id.count, 64)
        XCTAssertFalse(id.contains("example"))
        XCTAssertNil(payload.entries[0].answer)
        XCTAssertNil(payload.entries[0].answeredAt)
    }

    func test名前とメモはHubの数え方で上限に収める() throws {
        // Each of these is two UTF-16 units, which is how the Hub counts.
        let long = String(repeating: "😀", count: 300)
        let item = candidate(application: long, destination: long)
        let payload = OutboundCandidateSharePayload(
            report: report([item]), judgments: judgment(item, note: long), includesNotes: true
        )
        let entry = payload.entries[0]
        XCTAssertEqual(entry.application?.utf16.count, 254)
        XCTAssertEqual(entry.note?.utf16.count, 500)
        XCTAssertLessThanOrEqual(entry.destination?.utf16.count ?? 0, AgentLocalInsightBuilder.nameCharacterLimit)
    }

    func test一覧は20件までで全体の数は残す() throws {
        let many = (0..<25).map { candidate(destination: "host\($0).example") }
        let payload = OutboundCandidateSharePayload(
            report: OutboundCandidateReport(state: .ready, candidates: many, total: 31),
            judgments: [:], includesNotes: false
        )
        XCTAssertEqual(payload.entries.count, 20)
        XCTAssertEqual(payload.total, 31)
    }

    func test送るのをやめる知らせは中身を持たない() throws {
        let object = try json(.off())
        XCTAssertEqual(object["sharing"] as? Bool, false)
        XCTAssertEqual((object["entries"] as? [Any])?.count, 0)
        XCTAssertNil(object["state"])
    }

    func test送った時刻だけが違っても内容は同じとみなす() throws {
        let item = candidate()
        let first = OutboundCandidateSharePayload(report: report([item]), judgments: [:], includesNotes: false, generatedAt: day)
        let later = OutboundCandidateSharePayload(
            report: report([item]), judgments: [:], includesNotes: false, generatedAt: day.addingTimeInterval(600)
        )
        XCTAssertEqual(try first.contentHash(), try later.contentHash())
        let answered = OutboundCandidateSharePayload(
            report: report([item]), judgments: judgment(item, note: ""), includesNotes: false, generatedAt: day
        )
        XCTAssertNotEqual(try first.contentHash(), try answered.contentHash())
    }

    func test送るのは変わったときと6時間たったときだけ() {
        let now = day
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: true, hubMayHoldList: false, lastSentHash: nil, lastSentAt: nil, currentHash: "a", now: now
        ), .sendList)
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: true, hubMayHoldList: true, lastSentHash: "a", lastSentAt: now.addingTimeInterval(-3600),
            currentHash: "a", now: now
        ), .nothing)
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: true, hubMayHoldList: true, lastSentHash: "a", lastSentAt: now.addingTimeInterval(-3600),
            currentHash: "b", now: now
        ), .sendList)
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: true, hubMayHoldList: true, lastSentHash: "a", lastSentAt: now.addingTimeInterval(-6 * 3600),
            currentHash: "a", now: now
        ), .sendList)
    }

    func testオフにしたらHubに残っている間だけ消す知らせを送る() {
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: false, hubMayHoldList: true, lastSentHash: "a", lastSentAt: day, currentHash: nil, now: day
        ), .sendOff)
        XCTAssertEqual(OutboundCandidateSharePlan.decide(
            isEnabled: false, hubMayHoldList: false, lastSentHash: nil, lastSentAt: nil, currentHash: nil, now: day
        ), .nothing)
    }

    func test最初はどちらのスイッチもオフ() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "sharing-\(UUID().uuidString)"))
        let preferences = OutboundCandidateSharingPreferences(defaults: defaults)
        XCTAssertFalse(preferences.isEnabled)
        XCTAssertFalse(preferences.includesNotes)
        XCTAssertFalse(preferences.hubMayHoldList)
    }

    // MARK: - Sending

    private final class RecordingTransport: GeoCacheTransport, @unchecked Sendable {
        var requests: [URLRequest] = []
        let status: Int
        init(status: Int) { self.status = status }
        func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            requests.append(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (Data("{}".utf8), response)
        }
    }

    func testHubへはPUTでトークン付きで送る() async throws {
        let transport = RecordingTransport(status: 200)
        let uploader = OutboundCandidateUploader(
            hubURL: URL(string: "https://hub.example")!, token: "egva_test", userAgent: "EgressViewAgent/test",
            transport: transport
        )
        try await uploader.send(OutboundCandidateSharePayload(report: report([candidate()]), judgments: [:], includesNotes: false))
        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/agent/outbound-candidates")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer egva_test")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    }

    func test古いHubは404で分かる() async {
        let uploader = OutboundCandidateUploader(
            hubURL: URL(string: "https://hub.example")!, token: "t", userAgent: "u",
            transport: RecordingTransport(status: 404)
        )
        do {
            try await uploader.send(.off())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? OutboundCandidateShareError, .hubTooOld)
        }
    }

    func testHTTPSでないHubへは送らない() async {
        let transport = RecordingTransport(status: 200)
        let uploader = OutboundCandidateUploader(
            hubURL: URL(string: "http://hub.example")!, token: "t", userAgent: "u", transport: transport
        )
        do {
            try await uploader.send(.off())
            XCTFail("expected an error")
        } catch {
            XCTAssertEqual(error as? OutboundCandidateShareError, .insecureURL)
        }
        XCTAssertTrue(transport.requests.isEmpty)
    }
}

/// The same file the Hub's tests validate against its request schema, so a
/// change on either side that the other would refuse fails here first.
final class OutboundCandidateShareGoldenTests: XCTestCase {
    func test送る中身は共通の見本と一致する() throws {
        let day = Date(timeIntervalSince1970: 1_699_920_000)
        let before = day.addingTimeInterval(-86_400)
        let backup = OutboundCandidate(
            kind: .aboveUsual, at: day, application: "com.example.backup", destination: "example.net",
            bytesOut: 9_500_000_000, usualBytesOut: 400_000_000
        )
        let report = OutboundCandidateReport(state: .ready, candidates: [
            backup,
            OutboundCandidate(kind: .newPair, at: before, application: "curl", destination: "example.org", bytesOut: 120_000_000),
            OutboundCandidate(kind: .machine, at: before, bytesOut: 12_300_000_000, usualBytesOut: 8_100_000_000),
        ], total: 3)
        let judgments = [backup.id: OutboundCandidateJudgment(
            candidateID: backup.id, candidateAt: day, verdict: .expected, note: "My weekly backup",
            judgedAt: day.addingTimeInterval(3600)
        )]
        let payload = OutboundCandidateSharePayload(
            report: report, judgments: judgments, includesNotes: true, generatedAt: day.addingTimeInterval(7200)
        )
        let golden = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("protocol/agent-outbound-candidates/v1/golden.json")
        let expected = try JSONSerialization.jsonObject(with: Data(contentsOf: golden)) as? NSDictionary
        let actual = try JSONSerialization.jsonObject(with: payload.encoded()) as? NSDictionary
        XCTAssertEqual(actual, expected)
    }
}
