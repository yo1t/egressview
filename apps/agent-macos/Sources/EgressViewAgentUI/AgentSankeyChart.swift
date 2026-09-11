import AppKit
import EgressViewAgentCore
import SwiftUI

// Which application reached which destination, as ribbons between two columns.

public struct AgentSankeyChart: View {
    public let model: SankeyModel

    public init(model: SankeyModel) { self.model = model }

    public var body: some View {
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
                // Scrolls as one piece. The ribbons are drawn against the
                // same height the names are laid out in, so scrolling the
                // labels without the drawing would leave every band pointing
                // at the wrong row (P3-15).
                ScrollView(.vertical) {
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
                    .frame(height: contentHeight)
                }
                // Follows the card, which follows the window: how many names
                // are on screen is whatever the height allows, and the rest is
                // a scroll away. The minimum is three rows, so a short window
                // still shows a diagram rather than a scroll bar.
                .frame(minHeight: SankeyViewport.minimumHeight, maxHeight: .infinity)
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

    /// As tall as the longer column needs, so nothing is laid out into a
    /// height it does not have. The drawing is proportional to this, which is
    /// why the ribbons keep meeting their names while scrolling.
    ///
    /// No lower bound in rows. The first version of this floored the content
    /// at ten rows and gave the viewport exactly ten rows' worth, which made
    /// the diagram 210 points tall whatever the window did -- the card grew
    /// with the window and the drawing inside it did not (P3-15).
    private var contentHeight: CGFloat {
        SankeyViewport.contentHeight(
            rows: max(model.apps.count, model.destinations.count)
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

    /// One name row, and the heading above the column.
    ///
    /// Given to each row explicitly rather than estimated. The estimate was 21
    /// points against a caption row that measures about 16, so the canvas was
    /// laid out a third taller than the names beside it and the scroll extent
    /// was wrong by the same third.
    static let rowHeight = SankeyViewport.rowHeight
    static let headerHeight = SankeyViewport.headerHeight

    static let columnWidth: CGFloat = 150
    private static let dotWidth: CGFloat = 7
    private static let rowSpacing: CGFloat = 6

    /// The font the names are measured with -- and, below, the font they are
    /// drawn with. One constant used for both, because the two being allowed
    /// to differ is what broke this the first time it was fixed.
    ///
    /// Measuring used `preferredFont(forTextStyle: .caption1)`, which is 10
    /// points, while `.font(.caption)` draws at 11. Every label was judged
    /// against a name about 8% narrower than the one that reached the screen,
    /// so labels that "fitted" overflowed and were truncated again -- the very
    /// thing the measuring was added to prevent (P3-89).
    private static let font = NSFont.systemFont(ofSize: NSFont.smallSystemFontSize)

    private static func width(of text: String) -> CGFloat {
        (text as NSString).size(withAttributes: [.font: font]).width
    }

    private var valueTexts: [String] {
        nodes.map { formattedMetric($0.value, metric) }
    }

    /// The figures are given one width for the whole column, so the names do
    /// not shift about as the numbers change between refreshes.
    private var valueWidth: CGFloat {
        (valueTexts.map { Self.width(of: $0) } + [Self.width(of: "0")]).max() ?? 0
    }

    /// What is actually left for a name once the dot, the gaps and the figures
    /// have taken theirs.
    ///
    /// Two gaps, because the row below holds exactly three things. It used to
    /// hold four -- a `Spacer` sat between the name and the figure, and an
    /// `HStack` puts its spacing around every child, so the row spent three
    /// gaps while this subtracted two. Every name was measured against six
    /// points it did not have and was truncated a second time on the screen
    /// (P3-89, third attempt).
    ///
    /// The spacer is gone and each of the three has an explicit width, so the
    /// row adds up to the column exactly and this can be checked by reading
    /// it: 7 + 6 + name + 6 + figure = 150.
    private var nameWidth: CGFloat {
        max(0, Self.columnWidth - Self.dotWidth - Self.rowSpacing * 2 - valueWidth)
    }

    /// Names shortened together, so two destinations cannot read the same --
    /// and shortened to the room each one has, so nobody shortens them again.
    ///
    /// The question asked is width, not character count. A fixed budget of 18
    /// characters was right in the connections view and one point too wide in
    /// the data volume view, where `24.6 MB` takes more room than `17,187`:
    /// SwiftUI truncated the label a second time, from the end, which is
    /// where P3-86 puts the characters that tell two destinations apart
    /// (P3-89).
    ///
    /// Names are therefore a little shorter when the figures beside them are
    /// wider. That is the column being honest about its width; the
    /// alternative is a name that claims to be whole and is not.
    private var labels: [String] {
        let room = nameWidth
        return DestinationLabel.shorten(
            nodes.map { $0.isRemainder ? L("Other") : $0.name },
            fits: { Self.width(of: $0) <= room }
        )
    }

    public var body: some View {
        VStack(alignment: alignment, spacing: 0) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .frame(height: Self.headerHeight)
            ForEach(Array(zip(nodes, labels).enumerated()), id: \.element.0.name) { index, pair in
                row(index: index, node: pair.0, label: pair.1)
                    .frame(height: Self.rowHeight)
            }
            Spacer(minLength: 0)
        }
        // The measured font itself, not a style that resolves to something
        // else. `.caption` is 11 points here and `.caption1` is 10, and a
        // label measured against one and drawn in the other does not fit.
        .font(Font(Self.font))
        .frame(width: Self.columnWidth, alignment: alignment == .leading ? .leading : .trailing)
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
    private func row(index: Int, node: SankeyNode, label: String) -> some View {
        let dot = Circle()
            .fill(coloured
                  ? agentSeriesColor(index, isRemainder: node.isRemainder)
                  : Color.secondary.opacity(0.6))
            .frame(width: Self.dotWidth, height: Self.dotWidth)
        // Already shortened to what the column leaves for a name, so SwiftUI
        // is not asked to truncate again -- doing both would drop the part
        // that was kept to tell two destinations apart (P3-86, P3-89).
        let name = Text(label)
            .lineLimit(1)
            .frame(
                width: nameWidth,
                alignment: alignment == .leading ? .leading : .trailing
            )
        // The width the names were shortened against, given to the figures for
        // real. Without it the reservation is a number in a comment: the
        // widest row pushes the column and every name is measured against
        // space it does not have.
        let value = Text(formattedMetric(node.value, metric))
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .frame(
                width: valueWidth,
                alignment: alignment == .leading ? .trailing : .leading
            )

        HStack(spacing: Self.rowSpacing) {
            // The dot sits against the diagram on both sides, so each name
            // reads outward from the ribbon it belongs to.
            if alignment == .leading {
                dot
                name
                value
            } else {
                value
                name
                dot
            }
        }
    }
}
