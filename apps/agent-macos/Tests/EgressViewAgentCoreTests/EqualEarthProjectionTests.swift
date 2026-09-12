import XCTest
@testable import EgressViewAgentCore

/// The flat map's arithmetic: Equal Earth (P3-109).
final class EqualEarthProjectionTests: XCTestCase {
    private let projection = EqualEarthProjection()
    private let map = CGRect(x: 0, y: 0, width: 360, height: 360 / EqualEarthProjection.aspectRatio)

    func test極は赤道より狭い() {
        // The visible difference from a plate carrée, and the reason for the
        // choice: Equal Earth's meridians curve in, so a degree of longitude
        // at the pole takes less width than one at the equator. A rectangle
        // means the projection was not applied.
        let equator = projection.project(latitude: 0, longitude: 180, in: map).x
            - projection.project(latitude: 0, longitude: -180, in: map).x
        let nearPole = projection.project(latitude: 85, longitude: 180, in: map).x
            - projection.project(latitude: 85, longitude: -180, in: map).x
        XCTAssertLessThan(nearPole, equator * 0.6, "極付近が赤道と同じ幅で描かれている")
        XCTAssertGreaterThan(nearPole, 0)
    }

    func test上下と左右の端が地図の端に来る() {
        let top = projection.project(latitude: 90, longitude: 0, in: map)
        let bottom = projection.project(latitude: -90, longitude: 0, in: map)
        XCTAssertEqual(top.y, map.minY, accuracy: 0.001)
        XCTAssertEqual(bottom.y, map.maxY, accuracy: 0.001)
        XCTAssertEqual(projection.project(latitude: 0, longitude: -180, in: map).x, map.minX, accuracy: 0.001)
        XCTAssertEqual(projection.project(latitude: 0, longitude: 180, in: map).x, map.maxX, accuracy: 0.001)
    }

    func test縦横比は式から導かれる() {
        // Typed in, this would be one more constant nobody checks, and would
        // go quietly wrong the moment the projection changed.
        let width = EqualEarthProjection.unitPoint(latitude: 0, longitude: 180).x
        let height = EqualEarthProjection.unitPoint(latitude: 90, longitude: 0).y
        XCTAssertEqual(EqualEarthProjection.aspectRatio, CGFloat(width / height), accuracy: 0.000_001)
        // Equal Earth is a little wider than 2:1; a plate carrée is exactly 2.
        XCTAssertEqual(EqualEarthProjection.aspectRatio, 2.055, accuracy: 0.01)
    }

    func test赤道と本初子午線が中央を通る() {
        let centre = projection.project(latitude: 0, longitude: 0, in: map)
        XCTAssertEqual(centre.x, map.midX, accuracy: 0.001)
        XCTAssertEqual(centre.y, map.midY, accuracy: 0.001)
    }

    func test北が上() {
        // Screen coordinates run downward and latitude runs upward, which is
        // the one sign error that makes a world map look plausible and be
        // upside down.
        let north = projection.project(latitude: 60, longitude: 0, in: map)
        let south = projection.project(latitude: -60, longitude: 0, in: map)
        XCTAssertLessThan(north.y, south.y, "北半球が南半球より下に描かれている")
    }

    func test東が右() {
        let east = projection.project(latitude: 0, longitude: 140, in: map)
        let west = projection.project(latitude: 0, longitude: -140, in: map)
        XCTAssertGreaterThan(east.x, west.x)
    }

    func test地図は常に2対1で箱に収まる() {
        for bounds in [CGRect(x: 0, y: 0, width: 1000, height: 200),
                       CGRect(x: 0, y: 0, width: 200, height: 1000),
                       CGRect(x: 10, y: 20, width: 640, height: 320)] {
            let rect = projection.mapRect(fitting: bounds)
            XCTAssertEqual(rect.width / rect.height, EqualEarthProjection.aspectRatio, accuracy: 0.001,
                           "\(bounds)で縦横比が崩れた")
            XCTAssertTrue(bounds.insetBy(dx: -0.01, dy: -0.01).contains(rect), "\(bounds)からはみ出した")
        }
    }

    func test箱が無ければ地図も無い() {
        XCTAssertEqual(projection.mapRect(fitting: .zero), .zero)
    }
}

/// Splitting country outlines at the 180th meridian (P3-109).
///
/// Measured against the bundled atlas: seven segments cross it, belonging to
/// Fiji, Russia and Antarctica. Each one drew a line across the whole map
/// before this existed.
final class AntimeridianSplitTests: XCTestCase {
    private let projection = EqualEarthProjection()

    func test跨がない環はそのまま() {
        let ring = [(longitude: 10.0, latitude: 0.0), (longitude: 20.0, latitude: 5.0),
                    (longitude: 15.0, latitude: 10.0)]
        let pieces = projection.split(ring: ring)
        XCTAssertEqual(pieces.count, 1)
        XCTAssertEqual(pieces[0].count, ring.count)
    }

    func test跨ぐ環は二つになり端で終わる() {
        // The defect, stated as a test: joined, these two points draw a line
        // straight across the map.
        let ring = [(longitude: 170.0, latitude: 60.0), (longitude: -170.0, latitude: 62.0)]
        let pieces = projection.split(ring: ring)
        XCTAssertEqual(pieces.count, 2, "またぎが分割されていない")
        XCTAssertEqual(pieces[0].last?.longitude ?? 0, 180, accuracy: 0.001)
        XCTAssertEqual(pieces[1].first?.longitude ?? 0, -180, accuracy: 0.001)
    }

    func test端の緯度は両側で一致する() {
        // Otherwise the shape steps at the frame, which reads as a coastline
        // that is not there.
        let ring = [(longitude: 170.0, latitude: 60.0), (longitude: -170.0, latitude: 62.0)]
        let pieces = projection.split(ring: ring)
        XCTAssertEqual(pieces[0].last?.latitude ?? 0, pieces[1].first?.latitude ?? 1, accuracy: 0.001)
    }

    func test閉じた環は始点をまたいで繋ぎ直す() {
        // A ring starts wherever the data happens to start, which is almost
        // never on the meridian. Closed separately, the first piece draws a
        // chord from the frame back to that arbitrary point -- which is the
        // diagonal that appeared across Siberia once the crossings themselves
        // were handled.
        let ring = [
            (longitude: 100.0, latitude: 50.0),
            (longitude: 170.0, latitude: 60.0),
            (longitude: -170.0, latitude: 62.0),
            (longitude: -175.0, latitude: 55.0),
            (longitude: 175.0, latitude: 52.0),
            (longitude: 100.0, latitude: 50.0),
        ]
        let pieces = projection.split(ring: ring)
        XCTAssertEqual(pieces.count, 2, "始点をまたぐ断片が繋がっていない")
        for piece in pieces {
            let longitudes = piece.map(\.longitude)
            XCTAssertTrue(
                longitudes.allSatisfy { $0 >= 0 } || longitudes.allSatisfy { $0 <= 0 },
                "1つの断片が両半球にまたがっている: \(longitudes)"
            )
        }
    }

    func test実際の地図に長い跳びが残らない() throws {
        // The atlas itself, rather than a fixture: seven crossings, and every
        // one of them has to be gone after splitting.
        let atlas = try WorldAtlas.bundled()
        for country in atlas.countries {
            for ring in country.rings {
                for piece in projection.split(ring: ring) {
                    for (a, b) in zip(piece, piece.dropFirst()) {
                        XCTAssertLessThanOrEqual(
                            abs(b.longitude - a.longitude), 180,
                            "\(country.name)に地図を横切る線が残っている"
                        )
                    }
                }
            }
        }
    }
}
