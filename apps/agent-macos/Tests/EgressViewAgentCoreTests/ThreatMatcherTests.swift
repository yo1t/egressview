import XCTest
@testable import EgressViewAgentCore

final class ThreatMatcherTests: XCTestCase {
    private func matcher(_ indicators: [ThreatIndicator]) -> ThreatMatcher {
        ThreatMatcher(indicators: indicators)
    }

    private func ip(_ value: String) -> ThreatIndicator {
        ThreatIndicator(kind: .ip, value: value, source: "feodo", tag: "Dridex C2")
    }

    private func domain(_ value: String) -> ThreatIndicator {
        ThreatIndicator(kind: .domain, value: value, source: "urlhaus", tag: "malware")
    }

    private func cidr(_ value: String) -> ThreatIndicator {
        ThreatIndicator(kind: .cidr, value: value, source: "spamhaus", tag: "DROP")
    }

    func test_アドレス完全一致() {
        let result = matcher([ip("203.0.113.7")]).match(address: "203.0.113.7", hostname: nil)
        XCTAssertEqual(result?.matchedValue, "203.0.113.7")
        XCTAssertEqual(result?.indicator.source, "feodo")
    }

    func test_一致しなければnil() {
        XCTAssertNil(matcher([ip("203.0.113.7")]).match(address: "198.51.100.1", hostname: nil))
    }

    func test_ホスト名の完全一致() {
        let result = matcher([domain("bad.example")])
            .match(address: "203.0.113.7", hostname: "bad.example")
        XCTAssertEqual(result?.matchedValue, "bad.example")
    }

    /// The user must see which name was on the list, not just that something
    /// was: `evil.bad.example` is not itself listed.
    func test_親ドメインに一致したら一致した側を返す() {
        let result = matcher([domain("bad.example")])
            .match(address: "203.0.113.7", hostname: "evil.deep.bad.example")
        XCTAssertEqual(result?.matchedValue, "bad.example")
    }

    /// The parent walk stops at the last two labels, so a two-label domain is
    /// never derived from a longer one.
    func test_2ラベルより短い親は作らない() {
        XCTAssertNil(
            matcher([domain("example")]).match(address: "203.0.113.7", hostname: "a.b.example")
        )
    }

    /// Documents a property inherited from the Hub rather than a wish: neither
    /// side knows about public suffixes, so a feed listing `co.uk` would match
    /// every host under it. Making this side smarter would be worse, not
    /// better -- the same connection would get two verdicts depending on where
    /// it was looked at, and the operator would have to decide which to
    /// believe. If this needs fixing it has to be fixed in both.
    func test_公開suffixを区別しない点はHubと揃えてある() {
        let result = matcher([domain("co.uk")]).match(address: "203.0.113.7", hostname: "shop.co.uk")
        XCTAssertEqual(result?.matchedValue, "co.uk")
    }

    func test_ホスト名の大文字小文字を区別しない() {
        let result = matcher([domain("bad.example")])
            .match(address: "203.0.113.7", hostname: "BAD.Example")
        XCTAssertNotNil(result)
    }

    func test_CIDRに含まれるアドレス() {
        let result = matcher([cidr("198.51.100.0/24")])
            .match(address: "198.51.100.42", hostname: nil)
        XCTAssertEqual(result?.matchedValue, "198.51.100.0/24")
    }

    func test_CIDRの外は一致しない() {
        XCTAssertNil(
            matcher([cidr("198.51.100.0/24")]).match(address: "198.51.101.1", hostname: nil)
        )
    }

    /// The CIDR feeds publish no IPv6 ranges. Pretending to check them would be
    /// worse than not checking.
    func test_IPv6はCIDR照合の対象外() {
        XCTAssertNil(
            matcher([cidr("0.0.0.0/0")]).match(address: "2001:db8::1", hostname: nil)
        )
    }

    func test_順序はアドレス_ドメイン_CIDR() {
        let result = matcher([
            ip("198.51.100.42"),
            domain("bad.example"),
            cidr("198.51.100.0/24"),
        ]).match(address: "198.51.100.42", hostname: "bad.example")
        XCTAssertEqual(result?.matchedValue, "198.51.100.42", "アドレスの完全一致が最優先")
    }

    func test_ホスト名がアドレスと同一なら名前として扱わない() {
        let result = matcher([domain("203.0.113.7")])
            .match(address: "203.0.113.7", hostname: "203.0.113.7")
        XCTAssertNil(result)
    }

    func test_壊れたCIDRは黙って捨てる() {
        let subject = matcher([cidr("not-an-address/24"), cidr("198.51.100.0/99")])
        XCTAssertTrue(subject.isEmpty)
    }

    func test_指標が無ければ何にも一致しない() {
        let subject = matcher([])
        XCTAssertTrue(subject.isEmpty)
        XCTAssertNil(subject.match(address: "203.0.113.7", hostname: "bad.example"))
    }

    func test_prefix0のCIDRは全IPv4に一致する() {
        let result = matcher([cidr("0.0.0.0/0")]).match(address: "203.0.113.7", hostname: nil)
        XCTAssertNotNil(result)
    }
}

final class ThreatIndicatorStoreTests: XCTestCase {
    private func makeStore() throws -> (ObservationStore, URL) {
        let url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("threat-\(UUID().uuidString).sqlite")
        return (try ObservationStore(fileURL: url), url)
    }

    func test_指標を保存して読み戻す() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try store.replaceThreatIndicators([
            ThreatIndicator(kind: .ip, value: "203.0.113.7", source: "feodo", tag: "Dridex C2"),
            ThreatIndicator(kind: .domain, value: "bad.example", source: "urlhaus", tag: nil),
        ])
        let loaded = try store.threatIndicators()
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(try store.threatIndicatorCount(), 2)
        XCTAssertNil(loaded.first { $0.kind == .domain }?.tag)
    }

    /// A feed dropping an entry means it is no longer considered dangerous.
    /// Merging would keep condemning it forever.
    func test_置き換えであって併合ではない() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try store.replaceThreatIndicators([
            ThreatIndicator(kind: .ip, value: "203.0.113.7", source: "feodo", tag: nil),
        ])
        try store.replaceThreatIndicators([
            ThreatIndicator(kind: .ip, value: "198.51.100.1", source: "feodo", tag: nil),
        ])
        let loaded = try store.threatIndicators()
        XCTAssertEqual(loaded.count, 1)
        XCTAssertEqual(loaded.first?.value, "198.51.100.1")
    }

    func test_空で置き換えると全部消える() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        try store.replaceThreatIndicators([
            ThreatIndicator(kind: .ip, value: "203.0.113.7", source: "feodo", tag: nil),
        ])
        try store.replaceThreatIndicators([])
        XCTAssertEqual(try store.threatIndicatorCount(), 0)
    }

    func test_期間内の宛先を重複なく集める() throws {
        let (store, url) = try makeStore()
        defer { try? FileManager.default.removeItem(at: url) }
        let now = Date()
        let observation = ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: "203.0.113.7", remotePort: 443, processID: 1,
            processName: "curl", bundleID: nil,
            firstObservedAt: now, lastObservedAt: now,
            bytesIn: nil, bytesOut: nil, collector: .networkExtension,
            confidence: .exact, remoteHostname: "bad.example"
        )
        try store.append([observation, observation])

        let candidates = try store.destinationsForThreatMatching(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(candidates.count, 1)
        XCTAssertEqual(candidates.first?.address, "203.0.113.7")
        XCTAssertEqual(candidates.first?.hostname, "bad.example")
        XCTAssertGreaterThanOrEqual(candidates.first?.sessionCount ?? 0, 1)
    }
}

final class ThreatIsolationTests: XCTestCase {
    /// The verdict stays on this Mac. Sending "we think this destination is
    /// dangerous" to the Hub would tell it which addresses this agent is
    /// worried about -- the exact thing the whole design avoids by pulling the
    /// indicators instead of pushing the questions.
    ///
    /// Pinned against the encoded envelope rather than by reading the struct,
    /// so adding a field later cannot quietly change what leaves the machine.
    func test_送信envelopeに脅威の判定が入らない() throws {
        let observation = ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.5", localPort: 51234,
            remoteAddress: "203.0.113.7", remotePort: 443,
            processID: 501, processName: "curl", bundleID: nil,
            firstObservedAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastObservedAt: Date(timeIntervalSince1970: 1_700_000_060),
            bytesIn: 10, bytesOut: 20,
            collector: .networkExtension, confidence: .exact,
            remoteHostname: "bad.example"
        )
        let envelope = AgentIngestEnvelope(
            batchId: UUID(),
            sentAt: Date(timeIntervalSince1970: 1_700_000_100),
            agent: AgentIngestMetadata(
                hostName: "mac", platform: .macOS, osVersion: "15.0", agentVersion: "0.3.0"
            ),
            observations: [AgentIngestObservation(observationId: UUID(), observation: observation)]
        )
        let encoder = JSONEncoder()
        let json = String(data: try encoder.encode(envelope), encoding: .utf8) ?? ""

        for forbidden in ["threat", "indicator", "matched", "feodo", "urlhaus", "spamhaus"] {
            XCTAssertFalse(
                json.lowercased().contains(forbidden),
                "送信envelopeに \(forbidden) が含まれてはならない"
            )
        }
    }
}

extension ThreatMatcherTests {
    /// Two candidates that differ only by host name must not share an id.
    ///
    /// `destinationsForThreatMatching` groups by address, host name and
    /// process, so one address reached by one app appears twice whenever a
    /// name was resolved for some of its connections and not others -- which
    /// is ordinary, because names arrive from SNI after the flow opens. The id
    /// left the host name out, so both rows carried the same one and SwiftUI
    /// reported `ForEach` producing undefined results (P3-53).
    func testFindingsDifferingOnlyByHostNameHaveDistinctIDs() {
        let matcher = ThreatMatcher(indicators: [
            ThreatIndicator(kind: .ip, value: "198.51.100.5", source: "test", tag: nil),
        ])
        let named = ThreatCandidate(
            address: "198.51.100.5", hostname: "known.example",
            processName: "Example", sessionCount: 3,
            lastObservedAt: Date(timeIntervalSince1970: 100)
        )
        let unnamed = ThreatCandidate(
            address: "198.51.100.5", hostname: nil,
            processName: "Example", sessionCount: 1,
            lastObservedAt: Date(timeIntervalSince1970: 100)
        )

        let report = ThreatReport.evaluate(
            candidates: [named, unnamed], matcher: matcher, availability: .checked(indicatorCount: 1, fetchedAt: Date(timeIntervalSince1970: 50))
        )

        XCTAssertEqual(report.findings.count, 2)
        XCTAssertEqual(Set(report.findings.map { $0.id }).count, 2, "ids collided")
        // One address is still one destination to worry about.
        XCTAssertEqual(report.destinationCount, 1)
    }
}
