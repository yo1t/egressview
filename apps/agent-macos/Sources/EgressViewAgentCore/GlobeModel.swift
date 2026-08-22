import CoreGraphics
import Foundation

/// Why the map has nothing to show, so the screen can say which it is.
public enum GlobeUnavailableReason: Equatable, Sendable {
    /// No locations have ever been received. The agent is running without a
    /// Hub, or has not fetched yet.
    case noLocationData
    /// Locations are known, but nothing was observed in this period.
    case noTrafficInPeriod
}

public struct GlobePoint: Equatable, Sendable {
    public let latitude: Double
    public let longitude: Double
    public let countryCode: String?
    public let city: String?
    public let value: Double
    /// Share of the placed total, for sizing the mark.
    public let weight: Double
}

public struct GlobeModel: Equatable, Sendable {
    public let metric: TrafficMetric
    public let points: [GlobePoint]
    public let placedTotal: Double
    /// Traffic that could not be put anywhere.
    public let unplacedTotal: Double
    public let countryHistory: [CountryVisitSummary]
    /// Countries reached at any time since this history was enabled. This is
    /// independent of the selected period and is used only for the pale fill.
    public let visitedCountryCodes: Set<String>
    public let unavailable: GlobeUnavailableReason?

    public var isEmpty: Bool { points.isEmpty }

    /// True when enough traffic is missing that the map alone would mislead.
    public var coverageIsPartial: Bool { unplacedTotal > 0 }

    public var placedShare: Double {
        let total = placedTotal + unplacedTotal
        return total > 0 ? placedTotal / total : 0
    }
}

public struct GlobeAggregator: Sendable {
    public init() {}

    public func aggregate(
        placed: [PlacedDestination],
        unplacedSessions: Int,
        unplacedBytes: UInt64,
        metric: TrafficMetric,
        hasLocationData: Bool,
        countryHistory: [CountryVisitSummary] = []
    ) -> GlobeModel {
        let visitedCountryCodes = Set(countryHistory.map(\.countryCode))
        let value: (PlacedDestination) -> Double = { destination in
            metric == .sessions ? Double(destination.sessionCount) : Double(destination.bytes)
        }
        let unplaced = metric == .sessions ? Double(unplacedSessions) : Double(unplacedBytes)
        let weighted = placed.filter { value($0) > 0 }
        let total = weighted.reduce(0) { $0 + value($1) }

        guard hasLocationData else {
            // Without any locations the map is not empty, it is unavailable.
            // Those are different things and the screen should not confuse them.
            return GlobeModel(
                metric: metric, points: [], placedTotal: 0, unplacedTotal: unplaced,
                countryHistory: countryHistory,
                visitedCountryCodes: visitedCountryCodes,
                unavailable: .noLocationData
            )
        }
        guard total > 0 else {
            return GlobeModel(
                metric: metric, points: [], placedTotal: 0, unplacedTotal: unplaced,
                countryHistory: countryHistory,
                visitedCountryCodes: visitedCountryCodes,
                unavailable: visitedCountryCodes.isEmpty ? .noTrafficInPeriod : nil
            )
        }

        let points = weighted
            .map { destination in
                GlobePoint(
                    latitude: destination.latitude,
                    longitude: destination.longitude,
                    countryCode: destination.countryCode,
                    city: destination.city,
                    value: value(destination),
                    weight: value(destination) / total
                )
            }
            // Largest last so the busiest place is drawn on top of its neighbours.
            .sorted { ($0.value, $1.city ?? "") < ($1.value, $0.city ?? "") }

        return GlobeModel(
            metric: metric, points: points, placedTotal: total,
            unplacedTotal: unplaced, countryHistory: countryHistory,
            visitedCountryCodes: visitedCountryCodes,
            unavailable: nil
        )
    }
}

/// Where this Mac sits, for drawing traffic as leaving from somewhere.
///
/// The Hub lets the operator pick a home country. An agent has nobody to ask,
/// so it reads the region the machine is already configured for. That is a
/// guess about the country, never about the address: no lookup is made and
/// nothing is sent.
public enum HomeLocation {
    /// The same capital coordinates the Web UI uses, so the two maps agree.
    static let coordinates: [String: (latitude: Double, longitude: Double)] = [
        "JP": (35.68, 139.69), "US": (38.89, -77.04), "CA": (45.42, -75.69),
        "GB": (51.50, -0.12), "DE": (52.52, 13.40), "FR": (48.86, 2.35),
        "IT": (41.90, 12.50), "ES": (40.42, -3.70), "NL": (52.09, 5.10),
        "SE": (59.33, 18.07), "CH": (46.95, 7.45), "NO": (59.91, 10.75),
        "AU": (-35.28, 149.13), "NZ": (-41.29, 174.78), "CN": (39.91, 116.39),
        "KR": (37.57, 126.98), "TW": (25.04, 121.56), "HK": (22.32, 114.17),
        "SG": (1.35, 103.82), "IN": (28.61, 77.21), "BR": (-15.79, -47.88),
        "RU": (55.75, 37.62),
    ]

    public static func current(
        region: String? = Locale.current.region?.identifier
    ) -> (latitude: Double, longitude: Double) {
        guard let region, let match = coordinates[region.uppercased()] else {
            return coordinates["JP"]!
        }
        return match
    }
}

/// Points along the great circle between two places.
///
/// A straight line on a projected globe is not the path between two points on
/// a sphere, and drawing one would put the route through countries it does not
/// pass over.
public extension HomeLocation {
    /// How far to tip the globe, and which way.
    ///
    /// Towards the hemisphere the traffic leaves from. Every arc starts at this
    /// Mac, so the one place that must never be squashed against the rim is
    /// home -- tipping the other way hides exactly the point the picture is
    /// drawn around. The magnitude is small on purpose: enough to open up the
    /// home hemisphere, not so much that the equator stops reading as level.
    static func preferredTilt(
        latitude: Double, magnitude: Double = 12
    ) -> Double {
        latitude >= 0 ? magnitude : -magnitude
    }
}

public enum GreatCircle {
    public static func path(
        from origin: (latitude: Double, longitude: Double),
        to destination: (latitude: Double, longitude: Double),
        segments: Int = 48
    ) -> [(latitude: Double, longitude: Double)] {
        let steps = max(1, segments)
        let phi1 = origin.latitude * .pi / 180
        let lambda1 = origin.longitude * .pi / 180
        let phi2 = destination.latitude * .pi / 180
        let lambda2 = destination.longitude * .pi / 180

        let delta = 2 * asin(min(1, sqrt(
            pow(sin((phi2 - phi1) / 2), 2)
            + cos(phi1) * cos(phi2) * pow(sin((lambda2 - lambda1) / 2), 2)
        )))
        // The same point, or near enough that interpolation would divide by
        // roughly zero.
        guard delta > 1e-9 else { return [origin, destination] }

        return (0...steps).map { step in
            let fraction = Double(step) / Double(steps)
            let a = sin((1 - fraction) * delta) / sin(delta)
            let b = sin(fraction * delta) / sin(delta)
            let x = a * cos(phi1) * cos(lambda1) + b * cos(phi2) * cos(lambda2)
            let y = a * cos(phi1) * sin(lambda1) + b * cos(phi2) * sin(lambda2)
            let z = a * sin(phi1) + b * sin(phi2)
            return (
                latitude: atan2(z, sqrt(x * x + y * y)) * 180 / .pi,
                longitude: atan2(y, x) * 180 / .pi
            )
        }
    }
}

/// Orthographic projection: the globe as seen from a point above the surface.
///
/// Drawn rather than mapped. MapKit would fetch tiles from Apple, which cannot
/// be reconciled with an agent that must work without reaching anyone.
public struct OrthographicProjection: Sendable {
    public let centerLatitude: Double
    public let centerLongitude: Double

    public init(centerLatitude: Double = 20, centerLongitude: Double = 140) {
        self.centerLatitude = centerLatitude
        self.centerLongitude = centerLongitude
    }

    /// Returns nil for coordinates on the far side, which must not be drawn as
    /// if they were in front.
    public func project(latitude: Double, longitude: Double, in rect: CGRect) -> CGPoint? {
        let radius = min(rect.width, rect.height) / 2
        guard radius > 0 else { return nil }
        let phi = latitude * .pi / 180
        let lambda = (longitude - centerLongitude) * .pi / 180
        let phi0 = centerLatitude * .pi / 180

        let cosC = sin(phi0) * sin(phi) + cos(phi0) * cos(phi) * cos(lambda)
        guard cosC >= 0 else { return nil }

        let x = cos(phi) * sin(lambda)
        let y = cos(phi0) * sin(phi) - sin(phi0) * cos(phi) * cos(lambda)
        return CGPoint(
            x: rect.midX + CGFloat(x) * radius,
            y: rect.midY - CGFloat(y) * radius
        )
    }

    /// Where a hidden point sits on the rim, so the far side can be drawn
    /// faintly instead of vanishing.
    public func projectClamped(latitude: Double, longitude: Double, in rect: CGRect) -> CGPoint {
        if let visible = project(latitude: latitude, longitude: longitude, in: rect) {
            return visible
        }
        let radius = min(rect.width, rect.height) / 2
        let phi = latitude * .pi / 180
        let lambda = (longitude - centerLongitude) * .pi / 180
        let phi0 = centerLatitude * .pi / 180
        let x = cos(phi) * sin(lambda)
        let y = cos(phi0) * sin(phi) - sin(phi0) * cos(phi) * cos(lambda)
        let length = max(1e-9, sqrt(x * x + y * y))
        return CGPoint(
            x: rect.midX + CGFloat(x / length) * radius,
            y: rect.midY - CGFloat(y / length) * radius
        )
    }

    public func isVisible(latitude: Double, longitude: Double) -> Bool {
        project(latitude: latitude, longitude: longitude, in: CGRect(x: 0, y: 0, width: 2, height: 2)) != nil
    }
}
