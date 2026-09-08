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

    func test末尾だけが違う名前も区別できる() {
        // Found on the real machine on 2026-09-08, in the build that was
        // supposed to have fixed P3-86: two rows both read
        // `cdn-windows-clien…`. Keeping the head cannot separate names that
        // share their head, and these differ only after it.
        // These collide under middle truncation -- they share the first nine
        // characters and the last eight -- which is what put the same string
        // on two rows.
        let names = [
            "cdn-windows-client-a.example.com",
            "cdn-windows-client-b.example.com",
        ]
        XCTAssertEqual(
            DestinationLabel.middleTruncated(names[0], limit: 18),
            DestinationLabel.middleTruncated(names[1], limit: 18),
            "衝突しない名前を選んでしまっており、この試験は何も確かめていない"
        )
        let labels = DestinationLabel.shorten(names, limit: 18)
        XCTAssertNotEqual(labels[0], labels[1], "両方とも \(labels[0]) と読める")
        XCTAssertTrue(labels[0].contains("a"), "違いのある位置を落とした: \(labels[0])")
        XCTAssertTrue(labels[1].contains("b"), "違いのある位置を落とした: \(labels[1])")
    }

    func test先頭も末尾も共通で真ん中だけが違う名前を区別できる() {
        let names = [
            "cdn-windows-client-alpha.example.com",
            "cdn-windows-client-bravo.example.com",
        ]
        XCTAssertEqual(
            DestinationLabel.middleTruncated(names[0], limit: 18),
            DestinationLabel.middleTruncated(names[1], limit: 18),
            "衝突しない名前を選んでしまっており、この試験は何も確かめていない"
        )
        let labels = DestinationLabel.shorten(names, limit: 18)
        XCTAssertNotEqual(labels[0], labels[1])
        XCTAssertTrue(labels[0].contains("al"), "違いのある位置を落とした: \(labels[0])")
        XCTAssertTrue(labels[1].contains("br"), "違いのある位置を落とした: \(labels[1])")
    }

    func test省略しても上限の文字数を超えない() {
        let names = [
            "cdn-windows-client-a.example.com",
            "cdn-windows-client-b.example.com",
            "ipv6-cdn-041.example.video.net",
            "ipv6-cdn-042.example.video.net",
            "static.assets.example.com",
        ]
        for label in DestinationLabel.shorten(names, limit: 18) {
            XCTAssertLessThanOrEqual(label.count, 18, "\(label) が18文字を超えた")
        }
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
