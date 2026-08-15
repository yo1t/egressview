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
