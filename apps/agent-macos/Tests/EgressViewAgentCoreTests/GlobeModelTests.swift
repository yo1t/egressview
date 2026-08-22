import CoreGraphics
import Foundation
import XCTest
@testable import EgressViewAgentCore

private func placed(
    lat: Double, lon: Double, country: String? = "US", city: String? = "Somewhere",
    sessions: Int, bytes: UInt64 = 0
) -> PlacedDestination {
    PlacedDestination(
        latitude: lat, longitude: lon, countryCode: country, city: city,
        sessionCount: sessions, bytes: bytes
    )
}

final class GlobeAggregatorTests: XCTestCase {
    func testAnAgentWithNoLocationDataSaysSoRatherThanShowingAnEmptyWorld() {
        // Running without a Hub. "Nothing to place" and "nowhere was contacted"
        // are different facts and the screen must not confuse them.
        let model = GlobeAggregator().aggregate(
            placed: [], unplacedSessions: 500, unplacedBytes: 0,
            metric: .sessions, hasLocationData: false
        )
        XCTAssertEqual(model.unavailable, .noLocationData)
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.unplacedTotal, 500, "the traffic is still counted")
    }

    func testLocationsButNoTrafficIsADifferentMessage() {
        let model = GlobeAggregator().aggregate(
            placed: [], unplacedSessions: 0, unplacedBytes: 0,
            metric: .sessions, hasLocationData: true
        )
        XCTAssertEqual(model.unavailable, .noTrafficInPeriod)
    }

    func testAllTimeCountriesRemainVisibleWhenTheSelectedPeriodIsEmpty() {
        let now = Date()
        let model = GlobeAggregator().aggregate(
            placed: [], unplacedSessions: 0, unplacedBytes: 0,
            metric: .sessions, hasLocationData: true,
            countryHistory: ["JP", "US"].map {
                CountryVisitSummary(
                    countryCode: $0, firstObservedAt: now, lastObservedAt: now,
                    lastSiteName: "example.com", lastProcessName: "Safari",
                    connectionCount: 1
                )
            }
        )
        XCTAssertNil(model.unavailable, "the globe still has period-independent history to show")
        XCTAssertEqual(model.visitedCountryCodes, ["JP", "US"])
        XCTAssertTrue(model.points.isEmpty, "period points do not leak in from all-time history")
    }

    func testTrafficThatCannotBePlacedIsReportedRatherThanDropped() {
        // A map that quietly omits half the traffic is worse than one that says
        // how much it cannot place.
        let model = GlobeAggregator().aggregate(
            placed: [placed(lat: 35.6, lon: 139.7, sessions: 300)],
            unplacedSessions: 100, unplacedBytes: 0,
            metric: .sessions, hasLocationData: true
        )
        XCTAssertTrue(model.coverageIsPartial)
        XCTAssertEqual(model.placedTotal, 300)
        XCTAssertEqual(model.unplacedTotal, 100)
        XCTAssertEqual(model.placedShare, 0.75, accuracy: 0.001)
    }

    func testWeightsAreSharesOfWhatCouldBePlaced() {
        let model = GlobeAggregator().aggregate(
            placed: [
                placed(lat: 35.6, lon: 139.7, city: "Tokyo", sessions: 75),
                placed(lat: 37.4, lon: -122.1, city: "Mountain View", sessions: 25),
            ],
            unplacedSessions: 0, unplacedBytes: 0, metric: .sessions, hasLocationData: true
        )
        XCTAssertEqual(model.points.map(\.weight).reduce(0, +), 1.0, accuracy: 0.001)
        XCTAssertEqual(model.points.last?.city, "Tokyo", "the busiest place is drawn on top")
    }

    func testTheMetricChangesWhichPlaceLooksBusiest() {
        let rows = [
            placed(lat: 35.6, lon: 139.7, city: "Tokyo", sessions: 1_000, bytes: 1_000),
            placed(lat: 37.4, lon: -122.1, city: "Mountain View", sessions: 10, bytes: 9_000_000),
        ]
        let bySessions = GlobeAggregator().aggregate(
            placed: rows, unplacedSessions: 0, unplacedBytes: 0,
            metric: .sessions, hasLocationData: true
        )
        let byBytes = GlobeAggregator().aggregate(
            placed: rows, unplacedSessions: 0, unplacedBytes: 0,
            metric: .bytes, hasLocationData: true
        )
        XCTAssertEqual(bySessions.points.last?.city, "Tokyo")
        XCTAssertEqual(byBytes.points.last?.city, "Mountain View")
    }

    func testPlacesWithNothingMeasuredDrawNoMark() {
        // Under the byte metric an unmeasured flow contributes nothing, and a
        // zero-size mark would claim a visit with no traffic.
        let model = GlobeAggregator().aggregate(
            placed: [placed(lat: 35.6, lon: 139.7, sessions: 5, bytes: 0)],
            unplacedSessions: 0, unplacedBytes: 0, metric: .bytes, hasLocationData: true
        )
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.unavailable, .noTrafficInPeriod)
    }
}

final class OrthographicProjectionTests: XCTestCase {
    private let rect = CGRect(x: 0, y: 0, width: 200, height: 200)

    func testTheCentreOfTheViewIsTheCentreOfTheProjection() throws {
        let projection = OrthographicProjection(centerLatitude: 35, centerLongitude: 139)
        let point = try XCTUnwrap(projection.project(latitude: 35, longitude: 139, in: rect))
        XCTAssertEqual(point.x, rect.midX, accuracy: 0.001)
        XCTAssertEqual(point.y, rect.midY, accuracy: 0.001)
    }

    func testTheFarSideOfTheGlobeIsNotDrawn() {
        // Without this the antipode lands on the visible face and the map shows
        // traffic going somewhere it never went.
        let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: 0)
        XCTAssertNil(projection.project(latitude: 0, longitude: 180, in: rect))
        XCTAssertNotNil(projection.project(latitude: 0, longitude: 0, in: rect))
    }

    func testPointsStayInsideTheDisc() {
        let projection = OrthographicProjection(centerLatitude: 20, centerLongitude: 140)
        let radius = min(rect.width, rect.height) / 2
        for latitude in stride(from: -80.0, through: 80.0, by: 20) {
            for longitude in stride(from: -180.0, through: 180.0, by: 20) {
                guard let point = projection.project(
                    latitude: latitude, longitude: longitude, in: rect
                ) else { continue }
                let dx = point.x - rect.midX
                let dy = point.y - rect.midY
                XCTAssertLessThanOrEqual(sqrt(dx * dx + dy * dy), radius + 0.001)
            }
        }
    }

    func testEastAndWestLandOnOppositeSides() throws {
        let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: 0)
        let east = try XCTUnwrap(projection.project(latitude: 0, longitude: 45, in: rect))
        let west = try XCTUnwrap(projection.project(latitude: 0, longitude: -45, in: rect))
        XCTAssertGreaterThan(east.x, rect.midX)
        XCTAssertLessThan(west.x, rect.midX)
    }

    func testNorthIsUp() throws {
        let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: 0)
        let north = try XCTUnwrap(projection.project(latitude: 45, longitude: 0, in: rect))
        XCTAssertLessThan(north.y, rect.midY, "screen coordinates grow downwards")
    }

    func testAZeroSizedViewProducesNothing() {
        let projection = OrthographicProjection()
        XCTAssertNil(projection.project(latitude: 0, longitude: 0, in: .zero))
    }
}

final class GeoLocationStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-geo-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func observation(address: String, at: Date, bytes: UInt64?) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
            remoteAddress: address, remotePort: 443, processID: 501, processName: "Safari",
            bundleID: nil, firstObservedAt: at, lastObservedAt: at,
            bytesIn: bytes, bytesOut: bytes, collector: .networkExtension, confidence: .exact
        )
    }

    func testDestinationsAreMatchedToTheirLocationsAndTheRestAreCounted() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(address: "203.0.113.5", at: now, bytes: 10),
            observation(address: "203.0.113.5", at: now.addingTimeInterval(1), bytes: 10),
            observation(address: "198.51.100.9", at: now.addingTimeInterval(2), bytes: 5),
        ])
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.5", latitude: 35.6, longitude: 139.7,
                        countryCode: "JP", city: "Tokyo"),
        ])

        XCTAssertEqual(try store.geoLocationCount(), 1)
        let result = try store.destinationLocations(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(result.placed.count, 1)
        XCTAssertEqual(result.placed.first?.sessionCount, 2)
        XCTAssertEqual(result.placed.first?.city, "Tokyo")
        XCTAssertEqual(result.unplacedSessions, 1, "the destination with no location is still counted")
    }

    func testReplacingLocationsDoesNotAccumulateStaleOnes() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.1", latitude: 1, longitude: 1, countryCode: "JP", city: "A"),
            GeoLocation(ip: "203.0.113.2", latitude: 2, longitude: 2, countryCode: "JP", city: "B"),
        ])
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.1", latitude: 9, longitude: 9, countryCode: "US", city: "C"),
        ])
        XCTAssertEqual(try store.geoLocationCount(), 1)
    }

    func testAnAgentThatHasNeverReceivedLocationsReportsNone() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        XCTAssertEqual(try store.geoLocationCount(), 0, "standalone agents start with nothing")
    }
}

final class GreatCircleTests: XCTestCase {
    func testThePathStartsAndEndsWhereItShould() {
        let tokyo = (latitude: 35.68, longitude: 139.69)
        let washington = (latitude: 38.89, longitude: -77.04)
        let path = GreatCircle.path(from: tokyo, to: washington)

        XCTAssertEqual(path.first?.latitude ?? 0, tokyo.latitude, accuracy: 0.001)
        XCTAssertEqual(path.last?.longitude ?? 0, washington.longitude, accuracy: 0.001)
        XCTAssertEqual(path.count, 49)
    }

    func testTokyoToWashingtonGoesOverTheNorthRatherThanStraightAcross() {
        // A straight line on the projection would cross the Pacific at mid
        // latitudes. The real route arcs north, and drawing the straight one
        // would show traffic passing over countries it never goes near.
        let path = GreatCircle.path(
            from: (latitude: 35.68, longitude: 139.69),
            to: (latitude: 38.89, longitude: -77.04)
        )
        let highest = path.map(\.latitude).max() ?? 0
        XCTAssertGreaterThan(highest, 55, "the great circle rises well north of both ends")
    }

    func testEveryPointStaysOnTheGlobe() {
        let path = GreatCircle.path(
            from: (latitude: -35.28, longitude: 149.13),
            to: (latitude: 51.50, longitude: -0.12)
        )
        for point in path {
            XCTAssertGreaterThanOrEqual(point.latitude, -90)
            XCTAssertLessThanOrEqual(point.latitude, 90)
            XCTAssertGreaterThanOrEqual(point.longitude, -180.001)
            XCTAssertLessThanOrEqual(point.longitude, 180.001)
        }
    }

    func testTwoPointsInTheSamePlaceDoNotDivideByZero() {
        let here = (latitude: 35.68, longitude: 139.69)
        let path = GreatCircle.path(from: here, to: here)
        XCTAssertEqual(path.count, 2)
        XCTAssertTrue(path.allSatisfy { $0.latitude.isFinite && $0.longitude.isFinite })
    }
}

final class HomeLocationTests: XCTestCase {
    func testTheRegionTheMachineIsSetToDecidesWhereTrafficLeavesFrom() {
        // A guess about the country, never about the address: nothing is looked
        // up and nothing is sent.
        let japan = HomeLocation.current(region: "JP")
        XCTAssertEqual(japan.latitude, 35.68, accuracy: 0.001)
        let unitedStates = HomeLocation.current(region: "us")
        XCTAssertEqual(unitedStates.longitude, -77.04, accuracy: 0.001)
    }

    func testAnUnknownRegionFallsBackRatherThanLandingAtNullIsland() {
        // (0, 0) is in the Gulf of Guinea. Traffic drawn from there would be
        // wrong in a way that looks deliberate.
        for region in [nil, "ZZ", ""] {
            let fallback = HomeLocation.current(region: region)
            XCTAssertNotEqual(fallback.latitude, 0)
            XCTAssertNotEqual(fallback.longitude, 0)
        }
    }
}

final class GlobeOrientationTests: XCTestCase {
    private let rect = CGRect(x: 0, y: 0, width: 200, height: 200)

    /// The Earth turns counter-clockwise seen from above the north pole, which
    /// on screen means the surface travels to the right. Adding the spin to the
    /// centre longitude instead of subtracting it ran the planet backwards, and
    /// nothing in the picture said so.
    func test_中心経度が減ると地表は右へ動く() throws {
        let xs = try [10.0, 0.0, -10.0].map { centre -> CGFloat in
            let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: centre)
            return try XCTUnwrap(projection.project(latitude: 0, longitude: 0, in: rect)).x
        }
        XCTAssertLessThan(xs[0], xs[1])
        XCTAssertLessThan(xs[1], xs[2])
    }

    func test_中心緯度0なら赤道は水平な直線になる() throws {
        let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: 0)
        let ys = try [-60.0, -20.0, 0.0, 20.0, 60.0].map { longitude in
            try XCTUnwrap(projection.project(latitude: 0, longitude: longitude, in: rect)).y
        }
        for y in ys {
            XCTAssertEqual(y, rect.midY, accuracy: 0.0001)
        }
    }

    /// The equator must not tip as the globe turns, whatever the tilt.
    func test_回転しても赤道の形は変わらない() throws {
        func equatorHeights(centerLongitude: Double) throws -> [CGFloat] {
            let projection = OrthographicProjection(
                centerLatitude: -12, centerLongitude: centerLongitude
            )
            return try [-40.0, 0.0, 40.0].map { offset in
                try XCTUnwrap(
                    projection.project(
                        latitude: 0, longitude: centerLongitude + offset, in: rect
                    )
                ).y
            }
        }
        let first = try equatorHeights(centerLongitude: 0)
        let later = try equatorHeights(centerLongitude: 75)
        for (a, b) in zip(first, later) {
            XCTAssertEqual(a, b, accuracy: 0.0001)
        }
        XCTAssertEqual(first[0], first[2], accuracy: 0.0001, "赤道は左右対称のまま")
    }

    func test_極は上下に来る() throws {
        let projection = OrthographicProjection(centerLatitude: 0, centerLongitude: 0)
        let north = try XCTUnwrap(projection.project(latitude: 90, longitude: 0, in: rect))
        let south = try XCTUnwrap(projection.project(latitude: -90, longitude: 0, in: rect))
        XCTAssertEqual(north.x, rect.midX, accuracy: 0.0001)
        XCTAssertEqual(south.x, rect.midX, accuracy: 0.0001)
        XCTAssertLessThan(north.y, south.y, "北が上")
    }
}

final class GlobeTiltTests: XCTestCase {
    /// Home is where every arc starts, so the tilt must open up its hemisphere
    /// rather than push it towards the rim.
    func test_北半球なら北へ傾ける() {
        XCTAssertEqual(HomeLocation.preferredTilt(latitude: 35.68), 12, accuracy: 0.0001)
    }

    func test_南半球なら南へ傾ける() {
        XCTAssertEqual(HomeLocation.preferredTilt(latitude: -33.87), -12, accuracy: 0.0001)
    }

    func test_赤道上でも傾きは決まる() {
        XCTAssertEqual(HomeLocation.preferredTilt(latitude: 0), 12, accuracy: 0.0001)
    }

    /// Tipping towards home must actually raise home on screen.
    func test_傾けると通信元が画面の中心寄りへ来る() throws {
        let rect = CGRect(x: 0, y: 0, width: 200, height: 200)
        let home = (latitude: 35.68, longitude: 139.69)
        func homeY(tilt: Double) throws -> CGFloat {
            let projection = OrthographicProjection(
                centerLatitude: tilt, centerLongitude: home.longitude
            )
            return try XCTUnwrap(
                projection.project(latitude: home.latitude, longitude: home.longitude, in: rect)
            ).y
        }
        let level = try homeY(tilt: 0)
        let tippedToHome = try homeY(tilt: 12)
        let tippedAway = try homeY(tilt: -12)
        XCTAssertGreaterThan(tippedToHome, level, "北へ傾けると通信元は中心へ下りてくる")
        XCTAssertLessThan(tippedAway, level, "南へ傾けると通信元は縁へ押しやられる")
    }
}
