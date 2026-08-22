import Foundation
import XCTest
@testable import EgressViewAgentCore

final class WorldAtlasTests: XCTestCase {
    func testTheBundledAtlasLoadsAndCoversTheWorld() throws {
        let atlas = try WorldAtlas.bundled()
        XCTAssertGreaterThan(atlas.rings.count, 100, "177 countries, some with several rings")

        let points = atlas.rings.flatMap { $0 }
        XCTAssertGreaterThan(points.count, 5_000)
        // Coordinates that fall outside these bounds would be drawn somewhere
        // on the globe, and nowhere is correct.
        for point in points {
            XCTAssertGreaterThanOrEqual(point.longitude, -180.5)
            XCTAssertLessThanOrEqual(point.longitude, 180.5)
            XCTAssertGreaterThanOrEqual(point.latitude, -90.5)
            XCTAssertLessThanOrEqual(point.latitude, 90.5)
        }
        XCTAssertTrue(atlas.rings.allSatisfy { $0.count >= 3 }, "a ring needs three points to enclose anything")
        XCTAssertGreaterThanOrEqual(
            atlas.countries.compactMap(\.code).count, 170,
            "almost every Natural Earth geometry must map to an ISO country code"
        )
        XCTAssertNotNil(atlas.countries.first { $0.code == "JP" })
        XCTAssertNotNil(atlas.countries.first { $0.code == "US" })
    }

    func testLandExistsWhereItShould() throws {
        // A decoder that mangles the delta encoding still produces plausible
        // numbers, so check that outlines actually pass near known land.
        let atlas = try WorldAtlas.bundled()
        let points = atlas.rings.flatMap { $0 }
        func hasPointNear(longitude: Double, latitude: Double, within: Double) -> Bool {
            points.contains {
                abs($0.longitude - longitude) < within && abs($0.latitude - latitude) < within
            }
        }
        XCTAssertTrue(hasPointNear(longitude: 139, latitude: 35, within: 3), "Japan")
        // The 49th parallel: the US-Canada border, an actual outline rather
        // than a point inland where no border passes.
        XCTAssertTrue(hasPointNear(longitude: -100, latitude: 49, within: 2), "US-Canada border")
        XCTAssertTrue(hasPointNear(longitude: 20, latitude: -30, within: 5), "southern Africa")
    }

    func testAReversedArcIsWalkedBackwards() throws {
        // TopoJSON stores a shared border once and refers to it as ~i from the
        // other side. Getting that wrong ties countries together across the map.
        let topology: [String: Any] = [
            "type": "Topology",
            "transform": ["scale": [1.0, 1.0], "translate": [0.0, 0.0]],
            "arcs": [[[0.0, 0.0], [10.0, 0.0], [0.0, 10.0]]],
            "objects": [
                "countries": [
                    "type": "GeometryCollection",
                    "geometries": [
                        ["type": "Polygon", "arcs": [[0]]],
                        ["type": "Polygon", "arcs": [[-1]]],
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: topology)
        let atlas = try WorldAtlas(topoJSON: data)

        XCTAssertEqual(atlas.rings.count, 2)
        let forward = atlas.rings[0].map(\.longitude)
        let backward = atlas.rings[1].map(\.longitude)
        XCTAssertEqual(forward, [0, 10, 10])
        XCTAssertEqual(backward, forward.reversed())
    }

    func testMalformedDataIsRefusedRatherThanDrawnAsAnEmptyWorld() {
        XCTAssertThrowsError(try WorldAtlas(topoJSON: Data("{}".utf8))) { error in
            XCTAssertEqual(error as? WorldAtlas.AtlasError, .malformed)
        }
    }
}
