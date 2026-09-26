import XCTest
@testable import EgressViewAgentCore

/// The connection log names LAN, loopback and CGNAT destinations instead of
/// calling them unknown (P3-174), from the same range table that keeps them
/// away from location services.
final class NonPublicAddressNetworkNameTests: XCTestCase {
    func test_範囲ごとの名前() {
        let cases: [(String, String?)] = [
            ("10.0.0.1", "LAN"), ("172.16.0.1", "LAN"), ("172.31.255.255", "LAN"), ("192.168.1.1", "LAN"),
            ("169.254.169.254", "LAN"), ("fd12:3456::1", "LAN"), ("fc00::1", "LAN"), ("fe80::1", "LAN"),
            ("fe80::aede:48ff:fe00:1122%en0", "LAN"), ("::ffff:192.168.1.1", "LAN"), ("[fe80::1]", "LAN"),
            ("FE80::1", "LAN"),
            ("127.0.0.1", "loopback"), ("127.255.255.254", "loopback"), ("::1", "loopback"),
            ("100.64.0.1", "CGNAT"), ("100.127.255.255", "CGNAT"),
            // Next door is not.
            ("100.63.255.255", nil), ("100.128.0.0", nil), ("172.32.0.1", nil), ("192.169.0.1", nil),
            ("8.8.8.8", nil), ("2001:4860:4860::8888", nil),
            // Reserved, but not a LAN device one needs named.
            ("224.0.0.251", nil), ("ff02::fb", nil), ("192.0.2.1", nil), ("0.0.0.0", nil), ("::", nil),
            ("", nil), ("example.com", nil),
        ]
        for (address, name) in cases {
            XCTAssertEqual(NonPublicAddress.networkName(address), name, address)
        }
        XCTAssertEqual(NonPublicAddress.networkNames, ["LAN", "loopback", "CGNAT"])
    }

    /// The Hub's list is the reference, and the Windows Agent checks itself
    /// against it the same way.
    func test_Hubの表と同じ範囲に同じ名前() throws {
        let hubList = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("src/special-use-address.js")
        let text = try String(contentsOf: hubList, encoding: .utf8)
        let pattern = try NSRegularExpression(
            pattern: #"\[\s*'([0-9a-fA-F.:]+)'\s*,\s*(\d+)\s*(?:,\s*'([A-Za-z]+)'\s*)?\]"#)
        let matches = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
        XCTAssertEqual(matches.count, 25, "the Hub's fifteen IPv4 and ten IPv6 ranges")
        let ours = NonPublicAddress.ipv4Ranges + NonPublicAddress.ipv6Ranges
        for match in matches {
            let base = String(text[Range(match.range(at: 1), in: text)!])
            let bits = Int(text[Range(match.range(at: 2), in: text)!])!
            let name = Range(match.range(at: 3), in: text).map { String(text[$0]) }
            let mine = ours.first { $0.0 == base && $0.1 == bits }
            XCTAssertNotNil(mine, "the Hub lists \(base)/\(bits), and so does the Agent")
            XCTAssertEqual(mine?.2, name, "\(base)/\(bits) is shown the same way on both")
        }
    }

    func test_国の絞り込みはネットワーク名でも選べる() {
        let observation = ConnectionObservation(
            networkProtocol: .udp, localAddress: "192.168.1.20", localPort: 5353,
            remoteAddress: "192.168.1.1", remotePort: 53, processID: 1, processName: "mDNSResponder",
            bundleID: nil, firstObservedAt: Date(), lastObservedAt: Date(),
            bytesIn: nil, bytesOut: nil, collector: .networkExtension, confidence: .exact, remoteHostname: nil
        )
        var filter = ConnectionLogFilter()
        filter.country = "LAN"
        XCTAssertTrue(filter.matches(observation, destinationText: "192.168.1.1", countryCode: "LAN"))
        XCTAssertFalse(filter.matches(observation, destinationText: "8.8.8.8", countryCode: "US"))
        filter.country = nil
        filter.isUnplacedCountryOnly = true
        XCTAssertFalse(filter.matches(observation, destinationText: "192.168.1.1", countryCode: "LAN"),
                       "Unknown no longer includes the LAN")
        XCTAssertTrue(filter.matches(observation, destinationText: "203.0.113.9", countryCode: nil))
    }
}
