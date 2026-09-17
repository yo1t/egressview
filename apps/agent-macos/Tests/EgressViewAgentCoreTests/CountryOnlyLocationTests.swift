import SQLite3
import XCTest
@testable import EgressViewAgentCore

/// A location that knows the country and nothing more (P3-117).
///
/// The country table kept on this Mac is the country edition: it places an
/// address in a country and says nothing about where inside it. The map and
/// the glow need only that. The globe draws arcs and cannot use such a row --
/// and the traffic behind it must still be counted as unplaced, or it
/// disappears from the globe's own accounting, which is the thing this screen
/// exists not to do.
final class CountryOnlyLocationTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("country-only-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(_ address: String, at date: Date) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.1", localPort: 5000,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: "Test", bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: nil
        )])
    }

    func test国だけ分かる行は地図を塗る() throws {
        try observe("203.0.113.9", at: now)
        try store.addGeoLocations([.country("AU", ip: "203.0.113.9")], receivedAt: now)

        XCTAssertEqual(
            try store.countryCodes(forAddresses: ["203.0.113.9"]), ["203.0.113.9": "AU"]
        )
    }

    func test国だけ分かる行は地球儀に点を打たない() throws {
        try observe("203.0.113.9", at: now)
        try store.addGeoLocations([.country("AU", ip: "203.0.113.9")], receivedAt: now)

        let result = try store.destinationLocations(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertTrue(result.placed.isEmpty, "座標の無い行で弧を描こうとしている")
    }

    func test点を打てない通信は未配置として数える() throws {
        // The failure this guards against: the row exists, so the old
        // "no row at all" test for unplaced traffic would have skipped it, and
        // the session would have been counted nowhere.
        try observe("203.0.113.9", at: now)
        try store.addGeoLocations([.country("AU", ip: "203.0.113.9")], receivedAt: now)

        let result = try store.destinationLocations(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(result.unplacedSessions, 1, "どこにも数えられていない通信がある")
        XCTAssertEqual(result.unplacedBytes, 30)
    }

    func test座標のある行はこれまでどおり点になる() throws {
        try observe("198.51.100.7", at: now)
        try store.addGeoLocations([
            GeoLocation(
                ip: "198.51.100.7", latitude: 35.0, longitude: 139.0,
                countryCode: "JP", city: "Tokyo"
            ),
        ], receivedAt: now)

        let result = try store.destinationLocations(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(result.placed.count, 1)
        XCTAssertEqual(result.placed.first?.countryCode, "JP")
        XCTAssertEqual(result.unplacedSessions, 0)
    }

    func testv15移行で既存の座標が残る() throws {
        // The rebuild has to carry every row across: this table is the map.
        try store.addGeoLocations([
            GeoLocation(
                ip: "198.51.100.7", latitude: 35.0, longitude: 139.0,
                countryCode: "JP", city: "Tokyo"
            ),
        ], receivedAt: now)
        store = nil

        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        // Back to a v14 table, NOT NULL and all.
        XCTAssertEqual(
            sqlite3_exec(
                database,
                """
                ALTER TABLE geo_locations RENAME TO geo_old;
                CREATE TABLE geo_locations (
                    ip TEXT PRIMARY KEY, latitude REAL NOT NULL, longitude REAL NOT NULL,
                    country_code TEXT, city TEXT, received_at REAL NOT NULL
                );
                INSERT INTO geo_locations SELECT * FROM geo_old;
                DROP TABLE geo_old;
                PRAGMA user_version=14;
                """,
                nil, nil, nil
            ),
            SQLITE_OK
        )
        sqlite3_close(database)

        store = try ObservationStore(fileURL: url)
        XCTAssertEqual(
            try store.countryCodes(forAddresses: ["198.51.100.7"]), ["198.51.100.7": "JP"]
        )
        try observe("198.51.100.7", at: now)
        let result = try store.destinationLocations(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(result.placed.first?.latitude, 35.0, "移行で座標が失われた")
    }
}

/// The daily fetch from the Hub used to take the local answers with it
/// (P3-117).
final class LocalAnswersSurviveTheDailyFetchTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!
    private let now = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("survive-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    func test一括取得で国だけの行を消さない() throws {
        // Measured on one Mac 2026-09-18: 593 answers had left 11 rows, the
        // oldest five seconds younger than the daily fetch. Every locally
        // answered country vanished once a day.
        try store.addGeoLocations([.country("AU", ip: "203.0.113.9")], receivedAt: now)
        try store.replaceGeoLocations([
            GeoLocation(
                ip: "198.51.100.7", latitude: 35.0, longitude: 139.0,
                countryCode: "JP", city: "Tokyo"
            ),
        ], receivedAt: now.addingTimeInterval(60))

        XCTAssertEqual(
            try store.countryCodes(forAddresses: ["203.0.113.9"]), ["203.0.113.9": "AU"],
            "一括取得がこのMacの答えを消した"
        )
        XCTAssertEqual(
            try store.countryCodes(forAddresses: ["198.51.100.7"]), ["198.51.100.7": "JP"]
        )
    }

    func test一括取得は古い座標つきの行を入れ替える() throws {
        // The other half: the Hub's cache is still mirrored, not merged into.
        try store.replaceGeoLocations([
            GeoLocation(ip: "198.51.100.7", latitude: 1, longitude: 1, countryCode: "AU", city: nil),
        ], receivedAt: now)
        try store.replaceGeoLocations([
            GeoLocation(ip: "198.51.100.1", latitude: 2, longitude: 2, countryCode: "NZ", city: nil),
        ], receivedAt: now.addingTimeInterval(60))

        XCTAssertEqual(try store.countryCodes(forAddresses: ["198.51.100.7"]), [:])
        XCTAssertEqual(
            try store.countryCodes(forAddresses: ["198.51.100.1"]), ["198.51.100.1": "NZ"]
        )
    }

    func test座標が来たら国だけの行より優先する() throws {
        // Coordinates are more than a country, so the Hub's row wins.
        try store.addGeoLocations([.country("AU", ip: "198.51.100.7")], receivedAt: now)
        try store.replaceGeoLocations([
            GeoLocation(
                ip: "198.51.100.7", latitude: 35.0, longitude: 139.0,
                countryCode: "JP", city: "Tokyo"
            ),
        ], receivedAt: now.addingTimeInterval(60))

        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.1", localPort: 5000,
            remoteAddress: "198.51.100.7", remotePort: 443, processID: 1,
            processName: "Test", bundleID: nil,
            firstObservedAt: now.addingTimeInterval(120), lastObservedAt: now.addingTimeInterval(120),
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: nil
        )])
        let placed = try store.destinationLocations(
            from: now, to: now.addingTimeInterval(300)
        ).placed
        XCTAssertEqual(placed.first?.countryCode, "JP")
        XCTAssertEqual(placed.first?.latitude, 35.0)
    }
}
