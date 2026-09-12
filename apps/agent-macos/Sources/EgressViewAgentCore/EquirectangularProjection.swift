import CoreGraphics
import Foundation

/// The whole world at once, on a flat rectangle.
///
/// The globe answers "where did this go" beautifully and "how far does this
/// reach" badly: half of it is behind the sphere, and a reader has to turn it
/// to find out whether anything is there. The expanded country view exists to
/// be taken in at a glance (P3-109), so it needs a projection with no far
/// side.
///
/// Equirectangular, which is the plainest choice and deliberately so.
/// Longitude and latitude map straight onto x and y, so a reader who knows
/// where a country is on a wall map finds it here. It exaggerates area near
/// the poles; that is a real cost and the wrong one to fix here, because this
/// map answers "which countries", not "how much land".
public struct EquirectangularProjection: Sendable {
    /// The map is twice as wide as it is tall: 360 degrees against 180.
    public static let aspectRatio: CGFloat = 2

    public init() {}

    /// The largest 2:1 rectangle that fits, centred.
    ///
    /// Letterboxed rather than stretched. A map squeezed to fill its box puts
    /// countries in the wrong shape, and the reader has no way to know it
    /// happened.
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

    /// Every coordinate lands somewhere: there is no far side to hide.
    public func project(latitude: Double, longitude: Double, in mapRect: CGRect) -> CGPoint {
        let x = (longitude + 180) / 360
        let y = (90 - latitude) / 180
        return CGPoint(
            x: mapRect.minX + CGFloat(x) * mapRect.width,
            y: mapRect.minY + CGFloat(y) * mapRect.height
        )
    }
}
