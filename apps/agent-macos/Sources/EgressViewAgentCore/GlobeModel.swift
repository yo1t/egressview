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
        hasLocationData: Bool
    ) -> GlobeModel {
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
                unavailable: .noLocationData
            )
        }
        guard total > 0 else {
            return GlobeModel(
                metric: metric, points: [], placedTotal: 0, unplacedTotal: unplaced,
                unavailable: .noTrafficInPeriod
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
            unplacedTotal: unplaced, unavailable: nil
        )
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

    public func isVisible(latitude: Double, longitude: Double) -> Bool {
        project(latitude: latitude, longitude: longitude, in: CGRect(x: 0, y: 0, width: 2, height: 2)) != nil
    }
}
