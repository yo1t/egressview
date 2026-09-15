import XCTest
@testable import EgressViewAgentCore

private func bits(_ address: String, prefix: Int) -> [UInt8] {
    MaxMindDBFixture.addressBits(address, prefix: prefix)
}

/// Reading the country out of a MaxMind DB file, so the question never leaves
/// this Mac (P3-117).
final class MaxMindDBTests: XCTestCase {
    private func ipv4Database() throws -> MaxMindDB {
        try MaxMindDB(bytes: MaxMindDBFixture.build(
            entries: [
                .init(bits: bits("1.2.0.0", prefix: 16), countryCode: "JP"),
                .init(bits: bits("8.8.8.0", prefix: 24), countryCode: "US"),
                .init(bits: bits("203.0.113.0", prefix: 24), countryCode: "AU"),
            ],
            ipVersion: 4
        ))
    }

    func test住所から国が引ける() throws {
        let database = try ipv4Database()
        XCTAssertEqual(try database.countryCode(for: "1.2.3.4"), "JP")
        XCTAssertEqual(try database.countryCode(for: "8.8.8.8"), "US")
        XCTAssertEqual(try database.countryCode(for: "203.0.113.9"), "AU")
    }

    func test載っていないアドレスは答えない() throws {
        // Not an error: private ranges, unassigned space and addresses the
        // database does not place all arrive here. Unknown beats guessed.
        let database = try ipv4Database()
        XCTAssertNil(try database.countryCode(for: "9.9.9.9"))
        XCTAssertNil(try database.countryCode(for: "192.168.1.1"))
    }

    func test住所でないものは答えない() throws {
        let database = try ipv4Database()
        XCTAssertNil(try database.countryCode(for: "example.com"))
        XCTAssertNil(try database.countryCode(for: ""))
        XCTAssertNil(try database.countryCode(for: "1.2.3"))
    }

    func testIPv4専用のDBにIPv6を聞いても壊れない() throws {
        let database = try ipv4Database()
        XCTAssertNil(try database.countryCode(for: "2606:4700::1111"))
    }

    func testIPv6も引ける() throws {
        let database = try MaxMindDB(bytes: MaxMindDBFixture.build(
            entries: [.init(bits: bits("2606:4700::", prefix: 32), countryCode: "US")],
            ipVersion: 6
        ))
        XCTAssertEqual(try database.countryCode(for: "2606:4700::1111"), "US")
        XCTAssertNil(try database.countryCode(for: "2001:db8::1"))
    }

    func testIPv4射影アドレスは同じ答えになる() throws {
        // ::ffff:1.2.3.4 and 1.2.3.4 are the same address, and must not land in
        // different parts of the tree.
        let database = try ipv4Database()
        XCTAssertEqual(try database.countryCode(for: "::ffff:1.2.3.4"), "JP")
    }

    func test版の情報を読む() throws {
        // The licence requires moving to a new build and destroying the old one
        // within thirty days, so the agent has to know how old its copy is.
        let database = try MaxMindDB(bytes: MaxMindDBFixture.build(
            entries: [.init(bits: bits("1.0.0.0", prefix: 8), countryCode: "AU")],
            ipVersion: 4, buildEpoch: 1_757_000_000
        ))
        XCTAssertEqual(database.metadata.databaseType, "GeoLite2-Country")
        XCTAssertEqual(database.metadata.recordSize, 24)
        XCTAssertEqual(database.metadata.ipVersion, 4)
        XCTAssertEqual(database.metadata.buildEpoch, 1_757_000_000)
        XCTAssertEqual(database.metadata.builtAt, Date(timeIntervalSince1970: 1_757_000_000))
        XCTAssertEqual(
            database.metadata.age(now: Date(timeIntervalSince1970: 1_757_086_400)), 86_400
        )
    }

    func test壊れたファイルは例外になる() {
        XCTAssertThrowsError(try MaxMindDB(bytes: Data("not a database".utf8))) { error in
            XCTAssertEqual(error as? MaxMindDB.Failure, .noMetadata)
        }
    }
}

/// The data-section encoding, checked against the byte layouts the
/// specification gives rather than against the test builder.
final class MaxMindDBDecoderTests: XCTestCase {
    private func decode(_ bytes: [UInt8]) throws -> MaxMindDB.Value {
        let decoder = MaxMindDB.Decoder(bytes: Data(bytes), dataSectionStart: 0)
        return try decoder.value(at: 0)
    }

    func test短い文字列() throws {
        XCTAssertEqual(try decode([0x44, 0x41, 0x42, 0x43, 0x44]), .string("ABCD"))
    }

    func test長さが別バイトに書かれた文字列() throws {
        // Size 29 means "the next byte plus 29".
        let payload = Array(repeating: UInt8(0x41), count: 30)
        XCTAssertEqual(
            try decode([0x5D, 0x01] + payload), .string(String(repeating: "A", count: 30))
        )
    }

    func test数値は長さの分だけ読む() throws {
        XCTAssertEqual(try decode([0xC2, 0x01, 0x2C]), .uint(300))
        XCTAssertEqual(try decode([0xC0]), .uint(0), "長さ0は0を意味する")
    }

    func test真偽値は長さで表す() throws {
        XCTAssertEqual(try decode([0x00, 0x07]), .bool(false))
        XCTAssertEqual(try decode([0x01, 0x07]), .bool(true))
    }

    func test地図と配列() throws {
        let bytes: [UInt8] = [0xE1, 0x42, 0x68, 0x69, 0x02, 0x04, 0x41, 0x61, 0x41, 0x62]
        XCTAssertEqual(try decode(bytes), .map(["hi": .array([.string("a"), .string("b")])]))
    }

    func testポインタは前の値を指す() throws {
        // "ABCD" at offset 0, then a pointer back to it.
        XCTAssertEqual(
            try decode([0x44, 0x41, 0x42, 0x43, 0x44, 0x20, 0x00]).self, .string("ABCD"),
            "先頭の値そのものが返っている"
        )
        let decoder = MaxMindDB.Decoder(
            bytes: Data([0x44, 0x41, 0x42, 0x43, 0x44, 0x20, 0x00]), dataSectionStart: 0
        )
        XCTAssertEqual(try decoder.value(at: 5), .string("ABCD"), "ポインタが辿れていない")
    }

    func test輪になったポインタで止まらない() {
        // A pointer to itself. A file can say this; the agent must not hang.
        let decoder = MaxMindDB.Decoder(bytes: Data([0x20, 0x00]), dataSectionStart: 0)
        XCTAssertThrowsError(try decoder.value(at: 0))
    }

    func test端をはみ出す値は例外になる() {
        let decoder = MaxMindDB.Decoder(bytes: Data([0x4C, 0x41]), dataSectionStart: 0)
        XCTAssertThrowsError(try decoder.value(at: 0))
    }
}
