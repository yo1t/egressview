import XCTest
@testable import EgressViewAgentCore

/// The country table on this Mac: what it answers, and what it refuses to
/// answer (P3-117).
final class LocalCountryDatabaseTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("local-country-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func write(buildEpoch: UInt64) throws -> URL {
        let url = directory.appendingPathComponent("GeoLite2-Country.mmdb")
        try MaxMindDBFixture.countryDatabase(buildEpoch: buildEpoch).write(to: url)
        return url
    }

    func test表が無ければ何も答えない() {
        // The ordinary case: nobody has a table, and the Hub and the
        // third-party routes carry on exactly as before.
        let database = LocalCountryDatabase(
            url: directory.appendingPathComponent("missing.mmdb")
        )
        XCTAssertEqual(database.state(), .absent)
        XCTAssertNil(database.countryCode(for: "1.2.3.4"))
    }

    func test表があれば外に聞かずに答える() throws {
        let now = Date(timeIntervalSince1970: 1_757_100_000)
        let database = LocalCountryDatabase(url: try write(buildEpoch: 1_757_000_000))
        XCTAssertEqual(database.countryCode(for: "1.2.3.4", now: now), "JP")
        XCTAssertEqual(
            database.state(now: now),
            .ready(builtAt: Date(timeIntervalSince1970: 1_757_000_000),
                   databaseType: "GeoLite2-Country")
        )
    }

    func test30日を超えた表は使わない() throws {
        // Not merely stale: MaxMind's licence requires destroying a build more
        // than thirty days behind the current one, so continuing to answer from
        // it breaks the terms the file arrived under.
        let built: UInt64 = 1_757_000_000
        let database = LocalCountryDatabase(url: try write(buildEpoch: built))
        let later = Date(timeIntervalSince1970: TimeInterval(built) + 31 * 86_400)
        XCTAssertEqual(
            database.state(now: later), .expired(builtAt: Date(timeIntervalSince1970: TimeInterval(built)))
        )
        XCTAssertNil(
            database.countryCode(for: "1.2.3.4", now: later),
            "期限切れの表から答えてしまっている"
        )
    }

    func test壊れた表は理由を述べて黙る() throws {
        let url = directory.appendingPathComponent("GeoLite2-Country.mmdb")
        try Data("not a database".utf8).write(to: url)
        let database = LocalCountryDatabase(url: url)
        guard case let .unreadable(reason) = database.state() else {
            return XCTFail("壊れたファイルが使える扱いになっている")
        }
        XCTAssertFalse(reason.isEmpty)
        XCTAssertNil(database.countryCode(for: "1.2.3.4"))
    }

    func test入れ替えたら読み直す() throws {
        let url = directory.appendingPathComponent("GeoLite2-Country.mmdb")
        try MaxMindDBFixture.countryDatabase(buildEpoch: 1_757_000_000).write(to: url)
        let database = LocalCountryDatabase(url: url)
        XCTAssertEqual(database.countryCode(for: "1.2.3.4", now: Date(timeIntervalSince1970: 1_757_000_001)), "JP")

        try MaxMindDBFixture.countryDatabase(buildEpoch: 1_759_000_000).write(to: url)
        database.reload()
        XCTAssertEqual(
            database.state(now: Date(timeIntervalSince1970: 1_759_000_001)),
            .ready(builtAt: Date(timeIntervalSince1970: 1_759_000_000),
                   databaseType: "GeoLite2-Country")
        )
    }

    func test出典表示が用意されている() {
        // Required by the licence wherever the data is used.
        XCTAssertTrue(LocalCountryDatabase.attribution.contains("MaxMind"))
        XCTAssertTrue(LocalCountryDatabase.attribution.contains("https://www.maxmind.com"))
    }
}
