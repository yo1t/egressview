import AppKit
import EgressViewAgentCore
import SwiftUI

// Which application was talking, and when.

struct AgentTimelineChart: View {
    let model: TimelineModel
    let scale: TimeScale
    /// Shaded behind the bars. Without this a night of sleep is an empty
    /// stretch of chart, and an empty chart reads as "nothing happened" rather
    /// than "the Mac was not running".
    var sleepPeriods: [DateInterval] = []

    var body: some View {
        AgentChartCard(
            title: L("When traffic happened"),
            subtitle: L("Stacked by application, %@", scale.title)
        ) {
            if model.isEmpty {
                AgentEmptyChartNote(
                    text: model.byteCoverageIsPartial
                        ? L("No data volume has been measured in this period yet.")
                        : L("No connections in this period.")
                )
            } else {
                Canvas { context, size in draw(in: &context, size: size) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    // A Canvas is hit-tested where it drew, so the gaps
                    // between bars are not part of it and a pointer lands on
                    // nothing. The globe is an NSView and gets a solid frame
                    // for free, which is why it worked and these did not.
                    // The SwiftUI element is deliberately not used here; it
                    // did not receive VoiceOver on a real Mac twice over.
                    .background(AgentDrawingAccessibility(label: summary))
                AgentSeriesLegend(entries: model.series.enumerated().map {
                    .init(name: $0.element.name, color: agentSeriesColor($0.offset, isRemainder: $0.element.isRemainder))
                })
                if !sleepPeriods.isEmpty {
                    // Says what the shaded band is. An unexplained grey stripe
                    // is worse than no stripe.
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Self.sleepColor.opacity(0.22))
                            .overlay(
                                RoundedRectangle(cornerRadius: 2)
                                    .strokeBorder(Self.sleepColor.opacity(0.6), lineWidth: 1)
                            )
                            .frame(width: 18, height: 10)
                        Text(L("Shaded: the Mac was asleep. Traffic during sleep is not recorded."))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }
            if model.byteCoverageIsPartial {
                AgentPartialCoverageNote(count: model.observationsWithoutBytes)
            }
        }
    }

    private var summary: String {
        model.accessibilitySummary(
            empty: L("No connections in this period."),
            headline: { count, total, metric in
                L("%1$lld applications, %2$@ in total.", count, formattedMetric(total, metric))
            },
            busiest: { app, share, _ in L("%1$@ accounts for %2$lld percent.", app, share) }
        )
    }

    /// Room for the axis labels. Without them the chart shows a shape but no
    /// magnitude, and "is this a lot?" has no answer.
    private let yAxisWidth: CGFloat = 56
    private let xAxisHeight: CGFloat = 18

    /// Kept in one place so the band and its key cannot drift apart.
    static let sleepColor = Color.blue

    private func drawSleep(in context: inout GraphicsContext, plot: CGRect) {
        guard !sleepPeriods.isEmpty, let first = model.bucketStarts.first,
              model.bucketDuration > 0, model.bucketStarts.count > 1 else { return }
        let span = model.bucketDuration * Double(model.bucketStarts.count)
        guard span > 0 else { return }
        for period in sleepPeriods {
            let startX = plot.minX + plot.width * CGFloat(
                max(0, min(1, period.start.timeIntervalSince(first) / span))
            )
            let endX = plot.minX + plot.width * CGFloat(
                max(0, min(1, period.end.timeIntervalSince(first) / span))
            )
            // A sleep too short to draw is still drawn, as a hairline. A period
            // that vanished would be indistinguishable from one that never
            // happened.
            let rect = CGRect(
                x: startX, y: plot.minY, width: max(1, endX - startX), height: plot.height
            )
            // Blue, not grey. Grey already means the remainder series in this
            // chart, and two greys meaning different things in one picture is
            // how the reader ends up unable to tell whether the shading
            // appeared at all -- which is exactly what happened the first time
            // this was looked at.
            //
            // The band also gets an edge: on a chart whose bars are colourful
            // and dense, a wash alone does not read as a region.
            context.fill(Path(rect), with: .color(Self.sleepColor.opacity(0.22)))
            var edges = Path()
            edges.move(to: CGPoint(x: rect.minX, y: rect.minY))
            edges.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
            edges.move(to: CGPoint(x: rect.maxX, y: rect.minY))
            edges.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
            context.stroke(edges, with: .color(Self.sleepColor.opacity(0.6)), lineWidth: 1)
        }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let peak = model.bucketTotals.max() ?? 0
        guard peak > 0, model.bucketStarts.count > 1 else { return }
        let plot = CGRect(
            x: yAxisWidth, y: 0,
            width: max(1, size.width - yAxisWidth),
            height: max(1, size.height - xAxisHeight)
        )
        // Behind everything else: the sleep is the background the bars sit on,
        // not a thing drawn over them.
        drawSleep(in: &context, plot: plot)
        let step = plot.width / CGFloat(model.bucketStarts.count)
        var baselines = [CGFloat](repeating: plot.maxY, count: model.bucketStarts.count)

        // Gridlines and the values they stand for.
        for fraction in [0.0, 0.5, 1.0] {
            let y = plot.maxY - plot.height * fraction
            var line = Path()
            line.move(to: CGPoint(x: plot.minX, y: y))
            line.addLine(to: CGPoint(x: plot.maxX, y: y))
            context.stroke(line, with: .color(.secondary.opacity(0.18)), lineWidth: 1)
            let label = Text(formattedMetric(peak * fraction, model.metric))
                .font(.system(size: 9))
                .foregroundColor(.secondary)
            context.draw(label, at: CGPoint(x: yAxisWidth - 6, y: y), anchor: .trailing)
        }

        for (index, series) in model.series.enumerated() {
            var path = Path()
            for bucket in model.bucketStarts.indices {
                let value = series.values.indices.contains(bucket) ? series.values[bucket] : 0
                guard value > 0 else { continue }
                let height = plot.height * CGFloat(value / peak)
                let top = baselines[bucket] - height
                path.addRect(CGRect(
                    x: plot.minX + CGFloat(bucket) * step, y: top,
                    width: max(1, step - 1), height: height
                ))
                baselines[bucket] = top
            }
            context.fill(path, with: .color(agentSeriesColor(index, isRemainder: series.isRemainder)))
        }

        // Times along the bottom. Three is enough to read the span without
        // crowding the narrow scales.
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateFormat = scale == .week || scale == .month ? "M/d" : "H:mm"
        let last = model.bucketStarts.count - 1
        for (position, bucket) in [(0, 0), (1, last / 2), (2, last)] {
            guard model.bucketStarts.indices.contains(bucket) else { continue }
            let x = plot.minX + step * (CGFloat(bucket) + 0.5)
            let label = Text(formatter.string(from: model.bucketStarts[bucket]))
                .font(.system(size: 9))
                .foregroundColor(.secondary)
            let anchor: UnitPoint = position == 0 ? .leading : (position == 2 ? .trailing : .center)
            let clamped = position == 0 ? plot.minX : (position == 2 ? plot.maxX : x)
            context.draw(label, at: CGPoint(x: clamped, y: plot.maxY + xAxisHeight / 2), anchor: anchor)
        }
    }
}
