import EgressViewAgentCore
import SwiftUI

/// Every country the Mac has reached, shaded on one flat map.
///
/// The globe cannot answer "how far does this reach" -- half of it is behind
/// the sphere, and the reader has to turn it to find out whether anything is
/// there. This is the same history the destination list holds, drawn so it can
/// be taken in at once (P3-109).
///
/// A `Canvas` rather than the globe's `NSView`. `ImageRenderer` renders a
/// `Canvas` and draws an `NSViewRepresentable` as a placeholder, so this way
/// the map is visible to the offscreen render check (P3-105) and the globe is
/// not.
public struct AgentWorldMapChart: View {
    let atlas: WorldAtlas?
    let visitedCountryCodes: Set<String>
    /// Which countries have just been reached. Empty is the ordinary case and
    /// the cheap one: with nothing lit the map is a still picture and is drawn
    /// once.
    var glow = CountryGlow()
    /// The moment being drawn.
    ///
    /// Passed in rather than read from the clock here, and the redraws are
    /// driven by the model rather than by a `TimelineView`. Two reasons: the
    /// decision to stop animating when nothing is lit belongs in one place,
    /// and `ImageRenderer` draws a `TimelineView` in the wrong appearance --
    /// the offscreen check came back with a dark map where the app draws a
    /// light one, which would have hidden every future defect in this drawing
    /// behind a colour problem.
    var now = Date()

    public init(
        atlas: WorldAtlas?,
        visitedCountryCodes: Set<String>,
        glow: CountryGlow = CountryGlow(),
        now: Date = Date()
    ) {
        self.atlas = atlas
        self.visitedCountryCodes = visitedCountryCodes
        self.glow = glow
        self.now = now
    }

    private static let projection = EqualEarthProjection()

    public var body: some View {
        Canvas { context, size in
            draw(in: &context, size: size, at: now)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement()
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel(summary)
    }

    private var summary: String {
        visitedCountryCodes.isEmpty
            ? L("No destination countries have been recorded yet.")
            : L("%lld countries are shaded from all-time local history.", CountryCode.countries(visitedCountryCodes).count)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, at moment: Date) {
        let map = Self.projection.mapRect(fitting: CGRect(origin: .zero, size: size))
        guard map.width > 0, let atlas else { return }

        // The sea, so that a country nobody reached still reads as a place
        // rather than as a hole in the drawing. Drawn along the projection's
        // own outline: Equal Earth's meridians curve in towards the poles, so
        // a filled rectangle would be the sea of a different map.
        var sea = Path()
        let edge = Self.projection.outline(in: map)
        if let first = edge.first {
            sea.move(to: first)
            for point in edge.dropFirst() { sea.addLine(to: point) }
            sea.closeSubpath()
        }
        context.fill(sea, with: .color(.blue.opacity(0.06)))

        var unvisited = Path()
        var visited = Path()
        // Kept per country only for the ones that can light up, so an ordinary
        // frame builds two paths rather than two hundred.
        var shapesByCountry: [String: Path] = [:]
        for country in atlas.countries {
            let isVisited = country.code.map(visitedCountryCodes.contains) ?? false
            for ring in country.rings {
                guard ring.count > 1 else { continue }
                var shape = Path()
                // Split first: a ring that crosses the 180th meridian is two
                // shapes on a flat map, and drawing it as one puts a line
                // across the world.
                for piece in Self.projection.split(ring: ring) {
                    var started = false
                    for point in piece {
                        let projected = Self.projection.project(
                            latitude: point.latitude, longitude: point.longitude, in: map
                        )
                        if started {
                            shape.addLine(to: projected)
                        } else {
                            shape.move(to: projected)
                            started = true
                        }
                    }
                    shape.closeSubpath()
                }
                if isVisited { visited.addPath(shape) } else { unvisited.addPath(shape) }
                if let code = country.code, glow.intensity(for: code, at: moment) > 0.01 {
                    shapesByCountry[code, default: Path()].addPath(shape)
                }
            }
        }

        // Drawn in two passes rather than country by country, so a visited
        // country is never painted over by a neighbour drawn after it.
        context.fill(unvisited, with: .color(.secondary.opacity(0.22)))
        context.fill(visited, with: .color(.teal.opacity(0.75)))
        context.stroke(unvisited, with: .color(.secondary.opacity(0.35)), lineWidth: 0.5)
        context.stroke(visited, with: .color(.teal), lineWidth: 0.7)

        // Last, over the top: what is happening right now, on a map that is
        // otherwise a picture of everything that ever happened.
        for (code, shape) in shapesByCountry {
            let intensity = glow.intensity(for: code, at: moment)
            guard intensity > 0.01 else { continue }
            // A halo first, then the country itself. The halo is what makes it
            // read as light rather than as a change of colour: a country that
            // simply brightens looks like it was re-selected.
            context.stroke(
                shape,
                with: .color(.cyan.opacity(0.55 * intensity)),
                lineWidth: 1 + 7 * intensity
            )
            context.fill(shape, with: .color(.cyan.opacity(0.85 * intensity)))
        }
    }
}
