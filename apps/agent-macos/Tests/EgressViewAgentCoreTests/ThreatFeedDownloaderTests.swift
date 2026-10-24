import XCTest
@testable import EgressViewAgentCore

final class ThreatFeedParsingTests: XCTestCase {
    func test_feodoのIPを読み取る() {
        let text = """
        # comment
        2026-08-16 00:00:00,203.0.113.7,443,online,2026-08-01,Dridex
        """
        let result = ThreatFeedDownloader.parse(text, kind: .feodo, source: "feodo")
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.value, "203.0.113.7")
        XCTAssertEqual(result.first?.kind, .ip)
    }

    /// The indicator is the host. Keeping the port would stop it matching the
    /// same host reached on another one.
    func test_threatfoxはポートを落とす() {
        let text = "2026-08-16,1,203.0.113.7:8080,ip:port,botnet_cc,x,Emotet"
        let result = ThreatFeedDownloader.parse(text, kind: .threatfox, source: "threatfox")
        XCTAssertEqual(result.first?.value, "203.0.113.7")
    }

    func test_urlhausはURLからホストを取りIPと名前を区別する() {
        let text = """
        1,2026-08-16,http://bad.example/x.exe,online,y,malware,z
        2,2026-08-16,http://203.0.113.7/p.bin,online,y,malware,z
        """
        let result = ThreatFeedDownloader.parse(text, kind: .urlhaus, source: "urlhaus")
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result[0].kind, .domain)
        XCTAssertEqual(result[0].value, "bad.example")
        XCTAssertEqual(result[1].kind, .ip)
        XCTAssertEqual(result[1].value, "203.0.113.7")
    }

    func test_spamhausのCIDRを読み取りコメントを捨てる() {
        let text = """
        ; Spamhaus DROP List
        198.51.100.0/24 ; SBL123456
        # another comment

        203.0.113.0/25 ; SBL999
        """
        let result = ThreatFeedDownloader.parse(text, kind: .spamhausDrop, source: "spamhaus")
        XCTAssertEqual(result.count, 2)
        XCTAssertEqual(result.first?.kind, .cidr)
        XCTAssertEqual(result.first?.value, "198.51.100.0/24")
    }

    func test_壊れた行は黙って捨てる() {
        let text = """
        garbage
        2026-08-16 00:00:00,not-an-ip,443,online,2026-08-01,Dridex
        2026-08-16 00:00:00,203.0.113.7,443,online,2026-08-01,Dridex
        """
        let result = ThreatFeedDownloader.parse(text, kind: .feodo, source: "feodo")
        XCTAssertEqual(result.count, 1)
    }

    func test_引用符付きのカンマでも列がずれない() {
        let fields = ThreatFeedDownloader.csvFields("a,\"b,c\",d")
        XCTAssertEqual(fields, ["a", "b,c", "d"])
    }

    func test_空のフィードは空を返す() {
        XCTAssertTrue(ThreatFeedDownloader.parse("", kind: .feodo, source: "feodo").isEmpty)
    }

    /// The standalone path must read the same four lists the Hub does, or a
    /// Mac with a Hub and one without would disagree about what is dangerous.
    func test_Hubと同じ4つのフィードを見る() {
        let urls = ThreatFeedDownloader.feeds.compactMap { $0.url(abuseChAuthKey: "k1")?.absoluteString } // pragma: allowlist secret
        XCTAssertEqual(urls, [
            "https://feodotracker.abuse.ch/downloads/ipblocklist.csv",
            "https://threatfox-api.abuse.ch/v2/files/exports/k1/recent.csv",
            "https://urlhaus-api.abuse.ch/v2/files/exports/k1/recent.csv",
            "https://www.spamhaus.org/drop/drop.txt",
        ])
    }

    /// abuse.ch answers 410 at the keyless ThreatFox and URLhaus addresses
    /// since 2026-10-22, so without a key they are not requested at all.
    func test_キーが無ければThreatFoxとURLhausのURLを作らない() {
        let sources = ThreatFeedDownloader.feeds
            .filter { $0.url(abuseChAuthKey: nil) == nil }
            .map(\.source)
        XCTAssertEqual(sources, ["threatfox", "urlhaus"])
        XCTAssertTrue(ThreatFeedDownloader.feeds
            .filter { $0.url(abuseChAuthKey: "  ") == nil }.count == 2, "空白だけはキーとみなさない") // pragma: allowlist secret
    }

    func test_キーはパスとして符号化する() {
        let feed = ThreatFeedDownloader.feeds.first { $0.source == "threatfox" }!
        XCTAssertEqual(feed.url(abuseChAuthKey: "a/b?c")?.path, "/v2/files/exports/a/b?c/recent.csv") // pragma: allowlist secret
        XCTAssertNil(feed.url(abuseChAuthKey: "a/b?c")?.query) // pragma: allowlist secret
    }

    /// Downloading a list sends nothing about this Mac's traffic. Any query
    /// string would be the beginning of doing exactly that.
    func test_フィードURLに問い合わせ内容を載せない() {
        for feed in ThreatFeedDownloader.feeds {
            guard let url = feed.url(abuseChAuthKey: "k1") else { return XCTFail("\(feed.source)") } // pragma: allowlist secret
            XCTAssertNil(url.query, "\(url) にクエリを付けない")
            XCTAssertEqual(url.scheme, "https")
        }
    }

    // MARK: - ThreatFox keyed export (2026-10-22 onward)

    private let keyedHeader = "# \"first_seen_utc\",\"ioc_id\",\"ioc_value\",\"ioc_type\",\"threat_type\",\"fk_malware\",\"malware_alias\",\"malware_printable\",\"last_seen_utc\",\"confidence_level\",\"is_compromised\",\"reference\",\"tags\",\"anonymous\",\"reporter\""

    private func keyedRow(_ value: String, _ type: String, level: Int = 100, compromised: Bool = false, malware: String = "Remcos") -> String {
        "\"2026-10-24 01:50:00\", \"1\", \"\(value)\", \"\(type)\", \"botnet_cc\", \"win.x\", \"None\", \"\(malware)\", \"\", \"\(level)\", \"\(compromised ? "True" : "False")\", \"None\", \"None\", \"0\", \"r\""
    }

    private func parseKeyed(_ rows: [String]) -> [ThreatIndicator] {
        ThreatFeedDownloader.parse(([keyedHeader] + rows).joined(separator: "\r\n"), kind: .threatfox, source: "threatfox")
    }

    /// Read the way the Hub reads it, so both judge a destination alike.
    func test_threatfoxのdomainとurlもHubと同じ規則で読む() {
        let result = parseKeyed([
            keyedRow("203.0.113.7:4444", "ip:port", malware: "AsyncRAT"),
            keyedRow("c2.example.org", "domain"),
            keyedRow("hacked.example.com", "domain", compromised: true),
            keyedRow("weak.example.net", "domain", level: 50),
            keyedRow("https://Evil.Example.net/a.exe", "url"),
            keyedRow("https://raw.githubusercontent.com/u/r/x.ps1", "url"),
            keyedRow("http://198.51.100.9:8080/x", "url", malware: "Mirai"),
            keyedRow(String(repeating: "0", count: 32), "md5_hash"),
        ])
        let byValue = Dictionary(uniqueKeysWithValues: result.map { ($0.value, $0) })
        XCTAssertEqual(result.count, 7, "ハッシュは照合に使えないので取らない")
        XCTAssertEqual(byValue["203.0.113.7"]?.tag, "AsyncRAT")
        XCTAssertEqual(byValue["c2.example.org"]?.kind, .domain)
        XCTAssertEqual(byValue["c2.example.org"]?.confidence, .high)
        XCTAssertEqual(byValue["hacked.example.com"]?.confidence, .low)
        XCTAssertEqual(byValue["hacked.example.com"]?.tag, "Remcos (compromised legitimate site)")
        XCTAssertEqual(byValue["weak.example.net"]?.confidence, .low)
        XCTAssertEqual(byValue["evil.example.net"]?.confidence, .high)
        XCTAssertEqual(byValue["raw.githubusercontent.com"]?.confidence, .low)
        XCTAssertEqual(byValue["198.51.100.9"]?.kind, .ip)
        XCTAssertEqual(byValue["198.51.100.9"]?.tag, "Mirai")
    }

    func test_同じ指標が複数あれば強いほうを残す() {
        let result = parseKeyed([
            keyedRow("http://203.0.113.9/x", "url", level: 50, malware: "Other"),
            keyedRow("203.0.113.9:443", "ip:port", malware: "CobaltStrike"),
        ])
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.confidence, .high)
        XCTAssertEqual(result.first?.tag, "CobaltStrike")
    }

    // MARK: - Line endings
    //
    // Every existing fixture above uses LF, which is why this went unnoticed:
    // three of the four real feeds ship CRLF, and Swift treats "\r\n" as a
    // single Character, so `split(separator: "\n")` found no separator at all
    // and returned the whole download as one comment line. Zero indicators,
    // no error, from the day it was written.

    func test_CRLFのフィードを解析できる() {
        let text = "# comment\r\n\"2026-01-01 00:00:00\", \"1\", \"203.0.113.7:443\", \"ip:port\", \"botnet_cc\", \"win.remus\"\r\n"
        let result = ThreatFeedDownloader.parse(text, kind: .threatfox, source: "threatfox")
        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result.first?.value, "203.0.113.7")
    }

    func test_CRのみのフィードも解析できる() {
        let text = "# comment\r203.0.113.0/24 ; SBL1\r198.51.100.0/24 ; SBL2\r"
        let result = ThreatFeedDownloader.parse(text, kind: .spamhausDrop, source: "spamhaus")
        XCTAssertEqual(result.count, 2)
    }

    /// A CRLF file must not come back as one line. Pinned directly, because
    /// the symptom of the bug was "everything is a comment".
    func test_CRLFで行が分割される() {
        XCTAssertEqual(ThreatFeedDownloader.lines("a\r\nb\r\nc").count, 3)
        XCTAssertEqual(ThreatFeedDownloader.lines("a\nb\nc").count, 3)
        XCTAssertEqual(ThreatFeedDownloader.lines("a\rb\rc").count, 3)
    }

    // MARK: - Reporting what did not arrive

    private struct StubTransport: GeoCacheTransport {
        let bodies: [String: String]
        var statuses: [String: Int] = [:]
        func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let key = request.url?.host ?? ""
            let status = statuses[key] ?? 200
            guard let body = bodies[key] ?? (status == 200 ? nil : "") else {
                throw URLError(.cannotConnectToHost)
            }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            return (Data(body.utf8), response)
        }
    }

    /// Fetches nothing it is not given, and remembers what it was asked for.
    private final class RecordingTransport: GeoCacheTransport, @unchecked Sendable {
        private let lock = NSLock()
        private var _hosts: [String] = []
        var hosts: [String] { lock.withLock { _hosts } }
        func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            lock.withLock { _hosts.append(request.url?.host ?? "") }
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (Data("203.0.113.0/24 ; SBL1\n".utf8), response)
        }
    }

    func test_キーが無ければabuse_chの2つは要求せず_キーが必要と報告する() async throws {
        let transport = RecordingTransport()
        let result = try await ThreatFeedDownloader(transport: transport).download()
        XCTAssertEqual(Set(transport.hosts), ["feodotracker.abuse.ch", "www.spamhaus.org"])
        XCTAssertEqual(result.sourcesNeedingKey, ["threatfox", "urlhaus"])
        XCTAssertEqual(result.missingSources, [], "キーが無いことは取得の失敗ではない")
        XCTAssertFalse(result.isComplete)
    }

    func test_キーを拒否されたら拒否として報告する() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(
            bodies: ["www.spamhaus.org": "203.0.113.0/24 ; SBL1\n", "feodotracker.abuse.ch": "#\n"],
            statuses: ["threatfox-api.abuse.ch": 401, "urlhaus-api.abuse.ch": 403]
        ), abuseChAuthKey: "bad").download() // pragma: allowlist secret
        XCTAssertEqual(result.sourcesRejectingKey, ["threatfox", "urlhaus"])
        XCTAssertEqual(result.missingSources, [])
    }

    /// 2026-10-24: a fallback download replaced a Hub-enrolled Mac's 11,438
    /// indicators with 1,693, because the two feeds it could not read took
    /// their share of the stored set with them.
    func test_読めなかったフィードの分は持っていた指標を残す() {
        let result = ThreatFeedDownloader.DownloadResult(
            indicators: [ThreatIndicator(kind: .cidr, value: "203.0.113.0/24", source: "spamhaus", tag: nil)],
            missingSources: ["urlhaus"],
            sourcesNeedingKey: ["threatfox"]
        )
        let previous = [
            ThreatIndicator(kind: .cidr, value: "198.51.100.0/24", source: "spamhaus", tag: nil),
            ThreatIndicator(kind: .domain, value: "c2.example.org", source: "threatfox", tag: nil),
            ThreatIndicator(kind: .domain, value: "bad.example", source: "urlhaus", tag: nil),
            ThreatIndicator(kind: .ip, value: "203.0.113.5", source: "feodo", tag: nil),
        ]
        let merged = result.keepingPrevious(previous)
        XCTAssertEqual(Set(merged.indicators.map(\.value)), ["203.0.113.0/24", "c2.example.org", "bad.example"],
                       "読めたSpamhausとFeodoは今回の内容で置き換え、読めなかった2つは残す")
        XCTAssertEqual(merged.keptSources, ["urlhaus", "threatfox"])
    }

    /// 2026-10-24: the screen said 70,029 indicators while the store held
    /// 13,431, because URLhaus lists one host under many URLs and the count
    /// was taken before the store folded them together.
    func test_同じホストが何行あっても1件として数える() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(bodies: [
            "www.spamhaus.org": "203.0.113.0/24 ; SBL1\n",
            "threatfox-api.abuse.ch": ([keyedHeader, keyedRow("203.0.113.9:443", "ip:port")]).joined(separator: "\r\n"),
            "urlhaus-api.abuse.ch": """
                "1","2026-10-24","http://bad.example/a.exe"
                "2","2026-10-24","http://bad.example/b.exe"
                "3","2026-10-24","http://BAD.example/c.exe"
                "4","2026-10-24","http://203.0.113.9/x"
                "5","2026-10-24","http://203.0.113.9:8080/y"

                """,
            "feodotracker.abuse.ch": "# empty\n",
        ]), abuseChAuthKey: "k1").download() // pragma: allowlist secret
        XCTAssertEqual(result.indicators.count, 3, "\(result.indicators.map(\.value))")
        XCTAssertEqual(Set(result.indicators.map(\.value)), ["203.0.113.0/24", "203.0.113.9", "bad.example"])
    }

    func test_情報源をまたいでも強いほうを残す() {
        let weak = ThreatIndicator(kind: .domain, value: "x.example", source: "threatfox", tag: "weak", confidence: .low)
        let strong = ThreatIndicator(kind: .domain, value: "x.example", source: "urlhaus", tag: "strong", confidence: .high)
        XCTAssertEqual(ThreatFeedDownloader.strongestPerIndicator([weak, strong]), [strong])
        XCTAssertEqual(ThreatFeedDownloader.strongestPerIndicator([strong, weak]), [strong])
    }

    func test_同じ強さなら後のほうを残す_Hubと保存先に合わせる() {
        let first = ThreatIndicator(kind: .ip, value: "203.0.113.9", source: "threatfox", tag: "a")
        let later = ThreatIndicator(kind: .ip, value: "203.0.113.9", source: "urlhaus", tag: "b")
        XCTAssertEqual(ThreatFeedDownloader.strongestPerIndicator([first, later]), [later])
    }

    func test_残した指標と今回の指標が重なっても1件にする() {
        let result = ThreatFeedDownloader.DownloadResult(
            indicators: [ThreatIndicator(kind: .ip, value: "203.0.113.9", source: "threatfox", tag: nil)],
            missingSources: ["urlhaus"]
        )
        let merged = result.keepingPrevious([
            ThreatIndicator(kind: .ip, value: "203.0.113.9", source: "urlhaus", tag: nil),
        ])
        XCTAssertEqual(merged.indicators.count, 1)
        XCTAssertEqual(merged.keptSources, ["urlhaus"])
    }

    func test_持っていなければ残すものも無い() {
        let result = ThreatFeedDownloader.DownloadResult(indicators: [], missingSources: [], sourcesNeedingKey: ["threatfox"])
        let merged = result.keepingPrevious([])
        XCTAssertTrue(merged.indicators.isEmpty)
        XCTAssertEqual(merged.keptSources, [])
    }

    /// The failure that went unnoticed for the life of this code: a feed that
    /// downloads fine and parses to nothing looks exactly like a quiet one.
    func test_解析できなかったフィードは取得できなかったものとして報告する() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(bodies: [
            "www.spamhaus.org": "203.0.113.0/24 ; SBL1\n",
            "threatfox-api.abuse.ch": "# only comments\n",
            "urlhaus-api.abuse.ch": "# only comments\n",
            "feodotracker.abuse.ch": "# only comments\n",
        ]), abuseChAuthKey: "k1").download() // pragma: allowlist secret
        XCTAssertFalse(result.isComplete)
        XCTAssertEqual(result.missingSources.sorted(), ["threatfox", "urlhaus"])
        XCTAssertEqual(result.indicators.count, 1)
    }

    /// Feodo has published an empty list since 2026-03-04. A warning that never
    /// clears is one nobody reads, so an empty Feodo is a fact, not a fault.
    func test_空を出し続けるフィードは欠落として数えない() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(bodies: [
            "www.spamhaus.org": "203.0.113.0/24 ; SBL1\n",
            "threatfox-api.abuse.ch": "\"t\", \"1\", \"203.0.113.9:443\"\n",
            "urlhaus-api.abuse.ch": "\"1\",\"2026-01-01\",\"http://bad.example/x\"\n",
            "feodotracker.abuse.ch": "# empty for months\n",
        ]), abuseChAuthKey: "k1").download() // pragma: allowlist secret
        XCTAssertTrue(result.isComplete, "欠落: \(result.missingSources)")
    }

    func test_全部落ちたら失敗として投げる() async {
        do {
            _ = try await ThreatFeedDownloader(transport: StubTransport(bodies: [:])).download()
            XCTFail("全滅なら投げるべき")
        } catch {
            XCTAssertEqual(error as? ThreatFeedDownloader.DownloadError, .allFeedsFailed)
        }
    }
}
