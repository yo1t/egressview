import CoreGraphics
import Foundation

/// Geometry for the two-layer diagram.
///
/// Kept apart from the drawing so the parts that can be wrong — proportions,
/// stacking order, ribbon alignment — can be checked without a screen.
public struct SankeyLayout: Sendable {
    public struct NodeFrame: Equatable, Sendable {
        public let name: String
        public let rect: CGRect
        public let value: Double
        public let isRemainder: Bool
    }

    public struct LinkRibbon: Equatable, Sendable {
        public let source: String
        public let target: String
        public let value: Double
        /// Vertical span where the ribbon leaves the application.
        public let sourceRange: ClosedRange<CGFloat>
        /// Vertical span where it arrives at the destination.
        public let targetRange: ClosedRange<CGFloat>
    }

    public struct Result: Equatable, Sendable {
        public let apps: [NodeFrame]
        public let destinations: [NodeFrame]
        public let ribbons: [LinkRibbon]
    }

    public let nodeWidth: CGFloat
    public let nodeGap: CGFloat

    public init(nodeWidth: CGFloat = 12, nodeGap: CGFloat = 6) {
        self.nodeWidth = max(1, nodeWidth)
        self.nodeGap = max(0, nodeGap)
    }

    public func layout(_ model: SankeyModel, in size: CGSize) -> Result {
        guard !model.isEmpty, size.width > nodeWidth * 2, size.height > 0, model.total > 0 else {
            return Result(apps: [], destinations: [], ribbons: [])
        }

        let apps = stack(model.apps, x: 0, in: size)
        let destinations = stack(model.destinations, x: size.width - nodeWidth, in: size)

        // Ribbons leave and arrive in the order their nodes are stacked, which
        // keeps the same pair in the same place between refreshes.
        var sourceOffsets: [String: CGFloat] = [:]
        var targetOffsets: [String: CGFloat] = [:]
        let appByName = Dictionary(uniqueKeysWithValues: apps.map { ($0.name, $0) })
        let destinationByName = Dictionary(uniqueKeysWithValues: destinations.map { ($0.name, $0) })

        let ribbons = model.links.compactMap { link -> LinkRibbon? in
            guard let app = appByName[link.source],
                  let destination = destinationByName[link.target]
            else {
                return nil
            }
            let sourceThickness = app.rect.height * CGFloat(link.value / app.value)
            let targetThickness = destination.rect.height * CGFloat(link.value / destination.value)
            let sourceStart = app.rect.minY + sourceOffsets[link.source, default: 0]
            let targetStart = destination.rect.minY + targetOffsets[link.target, default: 0]
            sourceOffsets[link.source, default: 0] += sourceThickness
            targetOffsets[link.target, default: 0] += targetThickness

            return LinkRibbon(
                source: link.source,
                target: link.target,
                value: link.value,
                sourceRange: sourceStart...(sourceStart + max(0, sourceThickness)),
                targetRange: targetStart...(targetStart + max(0, targetThickness))
            )
        }

        return Result(apps: apps, destinations: destinations, ribbons: ribbons)
    }

    private func stack(_ nodes: [SankeyNode], x: CGFloat, in size: CGSize) -> [NodeFrame] {
        guard !nodes.isEmpty else { return [] }
        let total = nodes.reduce(0) { $0 + $1.value }
        guard total > 0 else { return [] }

        // Gaps come out of the available height first, so the column always
        // ends where the view ends however many nodes there are.
        //
        // With many nodes the requested gap can exceed the whole view. Letting
        // it stand would push the column past the bottom and leave every node
        // at zero height: a diagram that is both cut off and blank. The gap
        // gives way instead, so at least half the height always belongs to the
        // nodes themselves.
        let separators = CGFloat(max(0, nodes.count - 1))
        let effectiveGap = separators > 0
            ? min(nodeGap, size.height * 0.5 / separators)
            : 0
        let gaps = effectiveGap * separators
        let usable = max(0, size.height - gaps)
        var y: CGFloat = 0
        return nodes.map { node in
            let height = usable * CGFloat(node.value / total)
            let frame = NodeFrame(
                name: node.name,
                rect: CGRect(x: x, y: y, width: nodeWidth, height: height),
                value: node.value,
                isRemainder: node.isRemainder
            )
            y += height + effectiveGap
            return frame
        }
    }
}

public extension SankeyModel {
    /// One sentence describing the diagram, for anyone who cannot see it.
    ///
    /// A chart that reads as "group" to VoiceOver tells the user nothing about
    /// their own traffic.
    func accessibilitySummary(
        metricName: (TrafficMetric) -> String,
        formattedValue: (Double, TrafficMetric) -> String,
        empty: String,
        template: (_ metric: String, _ total: String, _ apps: Int, _ destinations: Int) -> String,
        leaders: (_ app: String, _ destination: String, _ share: Int) -> String
    ) -> String {
        guard !isEmpty, let topApp = apps.first, let topDestination = destinations.first else {
            return empty
        }
        let headline = template(
            metricName(metric), formattedValue(total, metric), apps.count, destinations.count
        )
        let share = Int((topApp.value / total * 100).rounded())
        return headline + " " + leaders(topApp.name, topDestination.name, share)
    }
}
