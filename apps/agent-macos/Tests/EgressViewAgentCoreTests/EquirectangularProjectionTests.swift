import XCTest
@testable import EgressViewAgentCore

/// The flat map's arithmetic (P3-109).
final class EquirectangularProjectionTests: XCTestCase {
    private let projection = EquirectangularProjection()
    private let map = CGRect(x: 0, y: 0, width: 360, height: 180)

    func test四隅が四隅に来る() {
        XCTAssertEqual(projection.project(latitude: 90, longitude: -180, in: map), CGPoint(x: 0, y: 0))
        XCTAssertEqual(projection.project(latitude: -90, longitude: 180, in: map), CGPoint(x: 360, y: 180))
    }

    func test赤道と本初子午線が中央を通る() {
        XCTAssertEqual(projection.project(latitude: 0, longitude: 0, in: map), CGPoint(x: 180, y: 90))
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
            XCTAssertEqual(rect.width / rect.height, EquirectangularProjection.aspectRatio, accuracy: 0.001,
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
    private let projection = EquirectangularProjection()

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
