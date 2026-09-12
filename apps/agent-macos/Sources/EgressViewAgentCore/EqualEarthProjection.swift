import CoreGraphics
import Foundation

/// The whole world at once, on one flat drawing, with areas kept true.
///
/// The globe answers "where did this go" beautifully and "how far does this
/// reach" badly: half of it is behind the sphere, and a reader has to turn it
/// to find out whether anything is there. The expanded country view exists to
/// be taken in at a glance (P3-109), so it needs a projection with no far
/// side.
///
/// Equal Earth (Šavrič, Patterson and Jenny, 2018). It is **equal-area**: a
/// country shaded here takes the share of the picture that it takes of the
/// world. That matters for this map in particular, because what it draws is
/// countries as coloured regions -- a projection that inflates the far north
/// would make a handful of northern destinations look like most of the planet.
///
/// The price is that shapes bend away from the centre and the meridians curve.
/// That is the trade Equal Earth is designed around, and the right way round
/// for a map whose whole content is "which of these regions".
public struct EqualEarthProjection: Sendable {
    // The published polynomial. Named rather than inlined so the formula below
    // reads as the paper's.
    private static let a1 = 1.340264
    private static let a2 = -0.081106
    private static let a3 = 0.000893
    private static let a4 = 0.003796
    private static let sqrt3 = 3.0.squareRoot()

    public init() {}

    /// Where a coordinate falls, in the projection's own units: x across, y
    /// up, both zero at (0°, 0°).
    static func unitPoint(latitude: Double, longitude: Double) -> (x: Double, y: Double) {
        let phi = latitude * .pi / 180
        let lambda = longitude * .pi / 180
        let theta = asin(sqrt3 / 2 * sin(phi))
        let t2 = theta * theta
        let t3 = t2 * theta
        let t6 = t3 * t3
        let t7 = t6 * theta
        let t8 = t7 * theta
        let t9 = t8 * theta
        let denominator = 3 * (9 * a4 * t8 + 7 * a3 * t6 + 3 * a2 * t2 + a1)
        let x = 2 * sqrt3 * lambda * cos(theta) / denominator
        let y = a4 * t9 + a3 * t7 + a2 * t3 + a1 * theta
        return (x, y)
    }

    /// How much wider than tall the drawing is.
    ///
    /// Computed from the formula rather than written down. A number typed here
    /// would be one more constant nobody checks, and it would go quietly wrong
    /// the moment the projection changed.
    public static let aspectRatio: CGFloat = {
        let halfWidth = unitPoint(latitude: 0, longitude: 180).x
        let halfHeight = unitPoint(latitude: 90, longitude: 0).y
        return CGFloat(halfWidth / halfHeight)
    }()

    /// The largest correctly-proportioned box that fits, centred.
    ///
    /// Letterboxed rather than stretched. A map squeezed to fill its box puts
    /// countries in the wrong shape -- and in an equal-area projection it also
    /// throws away the one property the projection was chosen for.
    public func mapRect(fitting bounds: CGRect) -> CGRect {
        guard bounds.width > 0, bounds.height > 0 else { return .zero }
        let width = min(bounds.width, bounds.height * Self.aspectRatio)
        let height = width / Self.aspectRatio
        return CGRect(
            x: bounds.midX - width / 2,
            y: bounds.midY - height / 2,
            width: width,
            height: height
        )
    }

    /// Every coordinate lands somewhere: there is no far side to hide.
    public func project(latitude: Double, longitude: Double, in mapRect: CGRect) -> CGPoint {
        let unit = Self.unitPoint(latitude: latitude, longitude: longitude)
        let halfWidth = Self.unitPoint(latitude: 0, longitude: 180).x
        let halfHeight = Self.unitPoint(latitude: 90, longitude: 0).y
        return CGPoint(
            x: mapRect.midX + CGFloat(unit.x / halfWidth) * mapRect.width / 2,
            // Screen coordinates run downward and latitude runs upward.
            y: mapRect.midY - CGFloat(unit.y / halfHeight) * mapRect.height / 2
        )
    }

    /// The outline of the world itself: down one edge of the map and up the
    /// other.
    ///
    /// The drawing is not a rectangle -- the meridians curve in towards the
    /// poles -- so the sea cannot be a filled box. Without this the map would
    /// sit on a rectangle of water with land floating inside it, which is the
    /// shape of a different projection.
    public func outline(in mapRect: CGRect, step: Double = 2) -> [CGPoint] {
        var points: [CGPoint] = []
        var latitude = -90.0
        while latitude <= 90 {
            points.append(project(latitude: latitude, longitude: -180, in: mapRect))
            latitude += step
        }
        latitude = 90
        while latitude >= -90 {
            points.append(project(latitude: latitude, longitude: 180, in: mapRect))
            latitude -= step
        }
        return points
    }

    /// Splits a ring where it crosses the 180th meridian.
    ///
    /// A country that straddles it -- Russia, Fiji, Antarctica's outline --
    /// has consecutive points at +179 and -179. Drawn as given, they join with
    /// a line straight across the map. Breaking the line instead leaves the
    /// piece unclosed, so closing it draws a chord across whatever it spans:
    /// the first fix moved the artefact from a horizontal stripe to a diagonal
    /// one over Siberia.
    ///
    /// What works is to walk each piece out to the edge of the map and start
    /// the next one at the opposite edge, so both close along the frame where
    /// the world actually continues.
    public func split(ring: [(longitude: Double, latitude: Double)])
        -> [[(longitude: Double, latitude: Double)]] {
        guard ring.count > 1 else { return ring.isEmpty ? [] : [ring] }
        var pieces: [[(longitude: Double, latitude: Double)]] = []
        var current: [(longitude: Double, latitude: Double)] = [ring[0]]
        for point in ring.dropFirst() {
            let previous = current[current.count - 1]
            let step = point.longitude - previous.longitude
            if abs(step) > 180 {
                // How far along the segment the meridian sits, measured the
                // short way round rather than across the whole map.
                let edge: Double = previous.longitude > 0 ? 180 : -180
                let remaining = abs(edge - previous.longitude)
                let total = 360 - abs(step)
                let fraction = total > 0 ? min(1, remaining / total) : 0.5
                let latitude = previous.latitude + (point.latitude - previous.latitude) * fraction
                current.append((longitude: edge, latitude: latitude))
                pieces.append(current)
                current = [(longitude: -edge, latitude: latitude), point]
            } else {
                current.append(point)
            }
        }
        pieces.append(current)

        // The ring's own start point is almost never on the meridian, so the
        // first piece and the last are two halves of one shape: closing them
        // separately draws a chord from the meridian back to wherever the data
        // happened to begin. Joined, they close along the frame like the rest.
        // This is what left a diagonal across Siberia after the crossings
        // themselves were handled.
        if pieces.count > 1, let first = pieces.first, let last = pieces.last,
           let start = first.first, let end = last.last,
           abs(start.longitude - end.longitude) < 0.000_001,
           abs(start.latitude - end.latitude) < 0.000_001 {
            pieces[0] = last.dropLast() + first
            pieces.removeLast()
        }
        return pieces.filter { $0.count > 1 }
    }
}
