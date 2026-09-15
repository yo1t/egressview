import XCTest
@testable import EgressViewAgentCore

/// Fetching the country table with the reader's own MaxMind account, so the
/// licence stays between them and MaxMind (P3-117).
final class GeoLite2UpdaterTests: XCTestCase {
    private struct StubTransport: GeoLite2Updater.Transport {
        let body: Data
        let status: Int
        let seen: @Sendable (URLRequest) -> Void

        func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            seen(request)
            return (
                body,
                HTTPURLResponse(
                    url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
                )!
            )
        }
    }

    private let credentials = GeoLite2Updater.Credentials(
        accountID: "123456", licenseKey: "abcdEFGH"
    )

    /// A real archive: the fixture database, tarred and gzipped by the system
    /// tools, so the reader is checked against files someone else wrote.
    private func archive(buildEpoch: UInt64 = 1_757_000_000) throws -> Data {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("geolite2-\(UUID().uuidString)")
        let inner = directory.appendingPathComponent("GeoLite2-Country_20260901")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try MaxMindDBFixture.countryDatabase(buildEpoch: buildEpoch)
            .write(to: inner.appendingPathComponent("GeoLite2-Country.mmdb"))

        let archive = directory.appendingPathComponent("archive.tar.gz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = [
            "-czf", archive.path, "-C", directory.path, "GeoLite2-Country_20260901",
        ]
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "tarが作れていない")
        return try Data(contentsOf: archive)
    }

    func test資格情報だけを送り宛先は送らない() async throws {
        // The reason a local table exists at all. This request carries the
        // account, not the addresses being watched.
        var request: URLRequest?
        let updater = GeoLite2Updater(transport: StubTransport(
            body: try archive(), status: 200, seen: { request = $0 }
        ))
        _ = try await updater.fetch(credentials: credentials)

        XCTAssertEqual(request?.url?.host, "download.maxmind.com")
        XCTAssertEqual(request?.url?.path, "/geoip/databases/GeoLite2-Country/download")
        XCTAssertEqual(request?.url?.query, "suffix=tar.gz")
        XCTAssertEqual(request?.url?.scheme, "https")
        XCTAssertEqual(
            request?.value(forHTTPHeaderField: "Authorization"),
            "Basic " + Data("123456:abcdEFGH".utf8).base64EncodedString()
        )
    }

    func test鍵をURLに置かない() {
        // Query strings end up in logs, proxies and shell history.
        let updater = GeoLite2Updater(transport: StubTransport(
            body: Data(), status: 200, seen: { _ in }
        ))
        let url = updater.request(for: credentials)?.url?.absoluteString ?? ""
        XCTAssertFalse(url.contains("abcdEFGH"), "ライセンスキーがURLに入っている")
        XCTAssertFalse(url.contains("123456"), "アカウントIDがURLに入っている")
    }

    func test書庫から中身を取り出す() async throws {
        let updater = GeoLite2Updater(transport: StubTransport(
            body: try archive(buildEpoch: 1_757_000_000), status: 200, seen: { _ in }
        ))
        let result = try await updater.fetch(credentials: credentials)
        XCTAssertEqual(result.metadata.databaseType, "GeoLite2-Country")
        XCTAssertEqual(result.metadata.buildEpoch, 1_757_000_000)
        XCTAssertEqual(try MaxMindDB(bytes: result.data).countryCode(for: "8.8.8.8"), "US")
    }

    func test資格情報が無ければ通信しない() async {
        var called = false
        let updater = GeoLite2Updater(transport: StubTransport(
            body: Data(), status: 200, seen: { _ in called = true }
        ))
        do {
            _ = try await updater.fetch(
                credentials: .init(accountID: "", licenseKey: "")
            )
            XCTFail("資格情報が無いのに進んだ")
        } catch {
            XCTAssertEqual(error as? GeoLite2Updater.Failure, .missingCredentials)
        }
        XCTAssertFalse(called, "資格情報が無いのに外部へ接続した")
    }

    func test鍵が違えばそう言う() async throws {
        let updater = GeoLite2Updater(transport: StubTransport(
            body: Data(), status: 401, seen: { _ in }
        ))
        do {
            _ = try await updater.fetch(credentials: credentials)
            XCTFail("401が例外にならなかった")
        } catch {
            XCTAssertEqual(error as? GeoLite2Updater.Failure, .unauthorised)
        }
    }

    func testデータベースでないものは受け取らない() async throws {
        // A proxy's error page, or a truncated download. Replacing a working
        // table with this would take away answers the agent already had.
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("geolite2-bad-\(UUID().uuidString)")
        let inner = directory.appendingPathComponent("GeoLite2-Country_20260901")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("not a database".utf8)
            .write(to: inner.appendingPathComponent("GeoLite2-Country.mmdb"))
        let archive = directory.appendingPathComponent("archive.tar.gz")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-czf", archive.path, "-C", directory.path, "GeoLite2-Country_20260901"]
        try process.run()
        process.waitUntilExit()

        let updater = GeoLite2Updater(transport: StubTransport(
            body: try Data(contentsOf: archive), status: 200, seen: { _ in }
        ))
        do {
            _ = try await updater.fetch(credentials: credentials)
            XCTFail("データベースでないものを受け取った")
        } catch {
            guard case .notADatabase = (error as? GeoLite2Updater.Failure) else {
                return XCTFail("想定と違う失敗: \(error)")
            }
        }
    }

    func test入れ替えは一段で行う() throws {
        // Half a file is a corrupt database. The old one survives until the new
        // one is complete.
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("geolite2-install-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let url = directory.appendingPathComponent("GeoLite2-Country.mmdb")
        try GeoLite2Updater.install(MaxMindDBFixture.countryDatabase(buildEpoch: 1), at: url)
        XCTAssertEqual(try MaxMindDB(contentsOf: url).metadata.buildEpoch, 1)

        try GeoLite2Updater.install(MaxMindDBFixture.countryDatabase(buildEpoch: 2), at: url)
        XCTAssertEqual(try MaxMindDB(contentsOf: url).metadata.buildEpoch, 2)
        XCTAssertEqual(
            try FileManager.default.contentsOfDirectory(atPath: directory.path).count, 1,
            "作業用ファイルが残っている"
        )
    }
}

/// gzip と tar を、他所のツールが書いたファイルで読めるか。
final class GzipTarTests: XCTestCase {
    func testシステムのgzipが書いたものを展開できる() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("gzip-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = Data((0..<50_000).map { UInt8($0 % 251) })
        let plain = directory.appendingPathComponent("payload.bin")
        try original.write(to: plain)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/gzip")
        process.arguments = ["-k", plain.path]
        try process.run()
        process.waitUntilExit()

        let compressed = try Data(contentsOf: directory.appendingPathComponent("payload.bin.gz"))
        XCTAssertEqual(try GzipTar.gunzip(compressed), original)
    }

    func testgzipでないものは断る() {
        XCTAssertThrowsError(try GzipTar.gunzip(Data("plain text".utf8))) { error in
            XCTAssertEqual(error as? GzipTar.Failure, .notGzip)
        }
    }

    func test無い名前は見つからないと言う() throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("tar-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data("hello".utf8).write(to: directory.appendingPathComponent("note.txt"))
        let archive = directory.appendingPathComponent("a.tar")
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
        process.arguments = ["-cf", archive.path, "-C", directory.path, "note.txt"]
        try process.run()
        process.waitUntilExit()

        XCTAssertThrowsError(
            try GzipTar.member(endingWith: ".mmdb", inTar: try Data(contentsOf: archive))
        ) { error in
            XCTAssertEqual(error as? GzipTar.Failure, .memberNotFound(".mmdb"))
        }
    }
}
