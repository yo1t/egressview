import Foundation

/// Country outlines for the globe.
///
/// Reads the same TopoJSON the Web UI uses, so the two maps look alike, and
/// carries it inside the app: MapKit would fetch tiles from Apple, which an
/// agent expected to work without reaching anyone cannot depend on.
public struct WorldAtlas: Sendable {
    /// One closed ring in degrees, longitude first.
    public typealias Ring = [(longitude: Double, latitude: Double)]

    public let rings: [Ring]

    public init(rings: [Ring]) {
        self.rings = rings
    }

    public static func bundled() throws -> WorldAtlas {
        guard let url = Bundle.module.url(
            forResource: "world-atlas-countries-110m", withExtension: "json"
        ) else {
            throw AtlasError.resourceMissing
        }
        return try WorldAtlas(topoJSON: Data(contentsOf: url))
    }

    public enum AtlasError: Error, Equatable {
        case resourceMissing
        case malformed
    }

    /// Decodes TopoJSON: arcs are delta-encoded integers that a shared
    /// transform turns back into degrees, and each shape refers to arcs by
    /// index rather than repeating shared borders.
    public init(topoJSON data: Data) throws {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let transform = root["transform"] as? [String: Any],
              let scale = transform["scale"] as? [Double], scale.count == 2,
              let translate = transform["translate"] as? [Double], translate.count == 2,
              let rawArcs = root["arcs"] as? [[[Double]]],
              let objects = root["objects"] as? [String: Any],
              let countries = objects["countries"] as? [String: Any],
              let geometries = countries["geometries"] as? [[String: Any]]
        else {
            throw AtlasError.malformed
        }

        let arcs: [Ring] = rawArcs.map { arc in
            var x = 0.0
            var y = 0.0
            return arc.compactMap { point in
                guard point.count >= 2 else { return nil }
                x += point[0]
                y += point[1]
                return (
                    longitude: x * scale[0] + translate[0],
                    latitude: y * scale[1] + translate[1]
                )
            }
        }

        func ring(for indices: [Int]) -> Ring {
            var result: Ring = []
            for index in indices {
                // A negative index means the arc is traversed backwards; the
                // encoding is ~i, so -1 is arc 0 reversed.
                let forward = index >= 0
                let position = forward ? index : ~index
                guard arcs.indices.contains(position) else { continue }
                let segment = forward ? arcs[position] : arcs[position].reversed()
                // The joining point is shared between consecutive arcs.
                result.append(contentsOf: result.isEmpty ? Array(segment) : Array(segment.dropFirst()))
            }
            return result
        }

        var collected: [Ring] = []
        for geometry in geometries {
            switch geometry["type"] as? String {
            case "Polygon":
                guard let polygon = geometry["arcs"] as? [[Int]] else { continue }
                collected.append(contentsOf: polygon.map(ring(for:)))
            case "MultiPolygon":
                guard let multi = geometry["arcs"] as? [[[Int]]] else { continue }
                for polygon in multi {
                    collected.append(contentsOf: polygon.map(ring(for:)))
                }
            default:
                continue
            }
        }
        rings = collected.filter { $0.count >= 3 }
    }
}
