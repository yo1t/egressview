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
}
