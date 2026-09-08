import XCTest
@testable import EgressViewAgentCore

/// P3-86。同じ表示になる宛先が4行並び、1.04 GBが「どこか4か所」としか読めなかった。
final class DestinationLabelTests: XCTestCase {
    func test衝突した名前は区別できるようになる() {
        // The measured case: four CDN nodes that middle-truncation collapsed
        // into one string.
        let names = [
            "ipv6-cdn-041.example.video.net",
            "ipv6-cdn-042.example.video.net",
            "ipv6-cdn-043.example.video.net",
            "ipv6-cdn-044.example.video.net",
        ]
        let labels = DestinationLabel.shorten(names, limit: 18)
        XCTAssertEqual(Set(labels).count, 4, "4つの宛先が \(Set(labels)) にまとまった")
    }

    func test衝突しない名前はこれまでどおり中央で省略する() {
        // The instinct behind middle truncation is right: the tail says which
        // domain, the head says which service. Only collisions change.
        let labels = DestinationLabel.shorten(["static.assets.example.com"], limit: 18)
        XCTAssertEqual(labels, ["static.as…mple.com"])
        XCTAssertTrue(labels[0].contains("…"))
        XCTAssertTrue(labels[0].hasSuffix("mple.com"), "末尾のドメインを落とした")
    }

    func test短い名前はそのまま返す() {
        let names = ["chatgpt.com", "aka.ms", "192.0.2.1"]
        XCTAssertEqual(DestinationLabel.shorten(names, limit: 18), names)
    }

    func test衝突していない行は影響を受けない() {
        // A set with one collision must not rewrite the names that were fine.
        let names = [
            "ipv6-cdn-041.example.video.net",
            "ipv6-cdn-042.example.video.net",
            "static.assets.example.com",
        ]
        let labels = DestinationLabel.shorten(names, limit: 18)
        XCTAssertEqual(labels[2], "static.as…mple.com")
        XCTAssertNotEqual(labels[0], labels[1])
    }

    func test三つ以上が衝突しても全部区別できる() {
        let names = (1...9).map { "node-00\($0).cdn.example.internal" }
        let labels = DestinationLabel.shorten(names, limit: 16)
        XCTAssertEqual(Set(labels).count, 9)
    }

    func test区別できる幅が無ければ落ちない() {
        // Below about eight characters there is nothing left to distinguish
        // with. It must still return one label per name rather than crash.
        let names = ["aaaaaaaaaaaa.example.com", "aaaaaaaaaaab.example.com"]
        let labels = DestinationLabel.shorten(names, limit: 2)
        XCTAssertEqual(labels.count, 2)
        XCTAssertFalse(labels[0].isEmpty)
    }

    func test空の入力を扱える() {
        XCTAssertEqual(DestinationLabel.shorten([], limit: 18), [])
    }

    func test同一の宛先が二度出ても壊れない() {
        // Not a collision to resolve -- they are the same destination.
        let labels = DestinationLabel.shorten(["a.example.com", "a.example.com"], limit: 18)
        XCTAssertEqual(labels[0], labels[1])
    }
}
