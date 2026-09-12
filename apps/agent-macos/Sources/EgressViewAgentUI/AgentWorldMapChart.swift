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

    public init(atlas: WorldAtlas?, visitedCountryCodes: Set<String>) {
        self.atlas = atlas
        self.visitedCountryCodes = visitedCountryCodes
    }

    private static let projection = EqualEarthProjection()

    public var body: some View {
        Canvas { context, size in
            draw(in: &context, size: size)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement()
        .accessibilityAddTraits(.isImage)
        .accessibilityLabel(summary)
    }

    private var summary: String {
        visitedCountryCodes.isEmpty
            ? L("No destination countries have been recorded yet.")
            : L("%lld countries are shaded from all-time local history.", visitedCountryCodes.count)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
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
            }
        }

        // Drawn in two passes rather than country by country, so a visited
        // country is never painted over by a neighbour drawn after it.
        context.fill(unvisited, with: .color(.secondary.opacity(0.22)))
        context.fill(visited, with: .color(.teal.opacity(0.75)))
        context.stroke(unvisited, with: .color(.secondary.opacity(0.35)), lineWidth: 0.5)
        context.stroke(visited, with: .color(.teal), lineWidth: 0.7)
    }
}
