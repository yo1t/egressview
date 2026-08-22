import Foundation

/// Country outlines for the globe.
///
/// Reads the same TopoJSON the Web UI uses, so the two maps look alike, and
/// carries it inside the app: MapKit would fetch tiles from Apple, which an
/// agent expected to work without reaching anyone cannot depend on.
public struct WorldAtlas: Sendable {
    /// One closed ring in degrees, longitude first.
    public typealias Ring = [(longitude: Double, latitude: Double)]

    public struct Country: Sendable {
        public let code: String?
        public let name: String
        public let rings: [Ring]
    }

    public let countries: [Country]
    public var rings: [Ring] { countries.flatMap(\.rings) }

    public init(rings: [Ring]) {
        countries = [Country(code: nil, name: "", rings: rings)]
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
              let countryObject = objects["countries"] as? [String: Any],
              let geometries = countryObject["geometries"] as? [[String: Any]]
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

        let english = Locale(identifier: "en_US")
        var codesByEnglishName: [String: String] = [:]
        for region in Locale.Region.isoRegions {
            guard let name = english.localizedString(forRegionCode: region.identifier) else { continue }
            if codesByEnglishName[name] == nil { codesByEnglishName[name] = region.identifier }
        }
        // Natural Earth's display names differ from CLDR for these regions.
        // Keep the exceptions explicit; guessing by a similar name could fill
        // the wrong country and would be worse than leaving one unfilled.
        let aliases: [String: String] = [
            "W. Sahara": "EH", "United States of America": "US",
            "Dem. Rep. Congo": "CD", "Dominican Rep.": "DO",
            "Falkland Is.": "FK", "Fr. S. Antarctic Lands": "TF",
            "Côte d'Ivoire": "CI", "Central African Rep.": "CF",
            "Congo": "CG", "Eq. Guinea": "GQ", "eSwatini": "SZ",
            "Palestine": "PS", "Myanmar": "MM", "Turkey": "TR",
            "Solomon Is.": "SB", "China": "CN", "Bosnia and Herz.": "BA",
            "Macedonia": "MK", "Trinidad and Tobago": "TT", "S. Sudan": "SS",
        ]

        var decodedCountries: [Country] = []
        for geometry in geometries {
            let properties = geometry["properties"] as? [String: Any]
            let name = properties?["name"] as? String ?? ""
            let code = aliases[name] ?? codesByEnglishName[name]
            var countryRings: [Ring] = []
            switch geometry["type"] as? String {
            case "Polygon":
                guard let polygon = geometry["arcs"] as? [[Int]] else { continue }
                countryRings.append(contentsOf: polygon.map(ring(for:)))
            case "MultiPolygon":
                guard let multi = geometry["arcs"] as? [[[Int]]] else { continue }
                for polygon in multi {
                    countryRings.append(contentsOf: polygon.map(ring(for:)))
                }
            default:
                continue
            }
            countryRings = countryRings.filter { $0.count >= 3 }
            if !countryRings.isEmpty {
                decodedCountries.append(Country(code: code, name: name, rings: countryRings))
            }
        }
        countries = decodedCountries
    }
}
