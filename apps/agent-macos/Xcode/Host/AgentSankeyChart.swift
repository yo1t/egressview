import AppKit
import EgressViewAgentCore
import SwiftUI

// Which application reached which destination, as ribbons between two columns.

struct AgentSankeyChart: View {
    let model: SankeyModel

    var body: some View {
        AgentChartCard(
            title: L("Which application went where"),
            subtitle: model.metric == .bytes
                ? L("Ribbon width is data volume")
                : L("Ribbon width is the number of connections")
        ) {
            if model.isEmpty {
                AgentEmptyChartNote(
                    text: model.byteCoverageIsPartial
                        ? L("No data volume has been measured in this period yet.")
                        : L("No connections in this period.")
                )
            } else {
                // Names beside the diagram rather than under it: a flow is read
                // left to right, and a legend below makes the reader carry a
                // colour across the card to find out what an end of a ribbon
                // is.
                HStack(alignment: .top, spacing: 12) {
                    AgentSankeyColumn(
                        title: L("Source"),
                        nodes: model.apps,
                        metric: model.metric,
                        coloured: true,
                        alignment: .leading
                    )
                    GeometryReader { proxy in
                        Canvas { context, size in draw(in: &context, size: size) }
                            .frame(width: proxy.size.width)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    AgentSankeyColumn(
                        title: L("Destination"),
                        nodes: model.destinations,
                        metric: model.metric,
                        coloured: false,
                        alignment: .trailing
                    )
                }
                // On the whole diagram, not on the ribbons alone, and with a
                // solid hit area: a Canvas is hit-tested where it drew, so the
                // space between ribbons belongs to nothing and a pointer lands
                // on nothing. The globe is an NSView, which gets a solid frame
                // for free -- that is why it worked and these did not.
                // As with the timeline: an NSView carries the element,
                // because the SwiftUI modifiers did not.
                .background(AgentDrawingAccessibility(label: summary))
            }
            if model.byteCoverageIsPartial {
                AgentPartialCoverageNote(count: model.observationsWithoutBytes)
            }
        }
    }

    private var summary: String {
        model.accessibilitySummary(
            metricName: { $0 == .bytes ? L("data volume") : L("connections") },
            formattedValue: formattedMetric,
            empty: L("No connections in this period."),
            template: { metric, total, apps, destinations in
                L("%1$@ of %2$@ across %3$lld applications and %4$lld destinations.",
                  total, metric, apps, destinations)
            },
            leaders: { app, destination, share in
                L("%1$@ accounts for %2$lld percent; the busiest destination is %3$@.",
                  app, share, destination)
            }
        )
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let inset = CGSize(width: size.width, height: max(0, size.height - 8))
        let layout = SankeyLayout(nodeWidth: 10, nodeGap: 6).layout(model, in: inset)
        let appIndex = Dictionary(uniqueKeysWithValues: layout.apps.enumerated().map { ($1.name, $0) })

        for ribbon in layout.ribbons {
            let colour = agentSeriesColor(
                appIndex[ribbon.source] ?? 0,
                isRemainder: ribbon.source == SankeyAggregator().remainderName
            )
            var path = Path()
            let leftX = layout.apps.first?.rect.maxX ?? 0
            let rightX = layout.destinations.first?.rect.minX ?? size.width
            let control = (rightX - leftX) * 0.5
            path.move(to: CGPoint(x: leftX, y: ribbon.sourceRange.lowerBound))
            path.addCurve(
                to: CGPoint(x: rightX, y: ribbon.targetRange.lowerBound),
                control1: CGPoint(x: leftX + control, y: ribbon.sourceRange.lowerBound),
                control2: CGPoint(x: rightX - control, y: ribbon.targetRange.lowerBound)
            )
            path.addLine(to: CGPoint(x: rightX, y: ribbon.targetRange.upperBound))
            path.addCurve(
                to: CGPoint(x: leftX, y: ribbon.sourceRange.upperBound),
                control1: CGPoint(x: rightX - control, y: ribbon.targetRange.upperBound),
                control2: CGPoint(x: leftX + control, y: ribbon.sourceRange.upperBound)
            )
            path.closeSubpath()
            context.fill(path, with: .color(colour.opacity(0.35)))
        }

        for (index, node) in layout.apps.enumerated() {
            context.fill(Path(node.rect), with: .color(agentSeriesColor(index, isRemainder: node.isRemainder)))
        }
        for node in layout.destinations {
            context.fill(Path(node.rect), with: .color(Color.secondary.opacity(0.6)))
        }
    }
}

/// One side of the sankey: the names of the ends of the ribbons, next to them.
private struct AgentSankeyColumn: View {
    let title: String
    let nodes: [SankeyNode]
    let metric: TrafficMetric
    let coloured: Bool
    let alignment: HorizontalAlignment

    var body: some View {
        VStack(alignment: alignment, spacing: 3) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            ForEach(Array(nodes.enumerated()), id: \.element.name) { index, node in
                row(index: index, node: node)
            }
            Spacer(minLength: 0)
        }
        .font(.caption)
        .frame(width: 150, alignment: alignment == .leading ? .leading : .trailing)
        // Hidden from VoiceOver, shown on screen.
        //
        // Measured 2026-09-03: these two columns put 38 separate elements
        // inside the diagram: a process name, then bare figures, then a
        // destination address, each read on its own. A bare "570" says nothing
        // about what it counts, and the same numbers are already in the summary
        // the drawing carries. The timeline and the globe are each one element;
        // this was the only drawing that was not.
        .accessibilityHidden(true)
    }

    @ViewBuilder
    private func row(index: Int, node: SankeyNode) -> some View {
        let dot = Circle()
            .fill(coloured
                  ? agentSeriesColor(index, isRemainder: node.isRemainder)
                  : Color.secondary.opacity(0.6))
            .frame(width: 7, height: 7)
        let name = Text(node.isRemainder ? L("Other") : node.name)
            .lineLimit(1)
            .truncationMode(.middle)
        let value = Text(formattedMetric(node.value, metric))
            .foregroundStyle(.secondary)
            .lineLimit(1)

        HStack(spacing: 6) {
            // The dot sits against the diagram on both sides, so each name
            // reads outward from the ribbon it belongs to.
            if alignment == .leading {
                dot
                name
                Spacer(minLength: 0)
                value
            } else {
                value
                Spacer(minLength: 0)
                name
                dot
            }
        }
    }
}
