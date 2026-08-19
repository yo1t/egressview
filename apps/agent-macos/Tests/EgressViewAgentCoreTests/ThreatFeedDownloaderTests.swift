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
        let urls = ThreatFeedDownloader.feeds.map(\.url.absoluteString)
        XCTAssertEqual(urls.count, 4)
        XCTAssertTrue(urls.contains { $0.contains("feodotracker.abuse.ch") })
        XCTAssertTrue(urls.contains { $0.contains("threatfox.abuse.ch") })
        XCTAssertTrue(urls.contains { $0.contains("urlhaus.abuse.ch") })
        XCTAssertTrue(urls.contains { $0.contains("spamhaus.org") })
    }

    /// Downloading a list sends nothing about this Mac's traffic. Any query
    /// string would be the beginning of doing exactly that.
    func test_フィードURLに問い合わせ内容を載せない() {
        for feed in ThreatFeedDownloader.feeds {
            XCTAssertNil(feed.url.query, "\(feed.url) にクエリを付けない")
            XCTAssertEqual(feed.url.scheme, "https")
        }
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
        func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            let key = request.url?.host ?? ""
            guard let body = bodies[key] else {
                throw URLError(.cannotConnectToHost)
            }
            let response = HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
            )!
            return (Data(body.utf8), response)
        }
    }

    /// The failure that went unnoticed for the life of this code: a feed that
    /// downloads fine and parses to nothing looks exactly like a quiet one.
    func test_解析できなかったフィードは取得できなかったものとして報告する() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(bodies: [
            "www.spamhaus.org": "203.0.113.0/24 ; SBL1\n",
            "threatfox.abuse.ch": "# only comments\n",
            "urlhaus.abuse.ch": "# only comments\n",
            "feodotracker.abuse.ch": "# only comments\n",
        ])).download()
        XCTAssertFalse(result.isComplete)
        XCTAssertEqual(result.missingSources.sorted(), ["threatfox", "urlhaus"])
        XCTAssertEqual(result.indicators.count, 1)
    }

    /// Feodo has published an empty list since 2026-03-04. A warning that never
    /// clears is one nobody reads, so an empty Feodo is a fact, not a fault.
    func test_空を出し続けるフィードは欠落として数えない() async throws {
        let result = try await ThreatFeedDownloader(transport: StubTransport(bodies: [
            "www.spamhaus.org": "203.0.113.0/24 ; SBL1\n",
            "threatfox.abuse.ch": "\"t\", \"1\", \"203.0.113.9:443\"\n",
            "urlhaus.abuse.ch": "\"1\",\"2026-01-01\",\"http://bad.example/x\"\n",
            "feodotracker.abuse.ch": "# empty for months\n",
        ])).download()
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
