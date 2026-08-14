import Foundation

public struct TimelineSeries: Equatable, Sendable {
    public let name: String
    /// One value per bucket, always the full bucket count.
    public let values: [Double]
    public let isRemainder: Bool

    public var total: Double { values.reduce(0, +) }
}

public struct TimelineModel: Equatable, Sendable {
    public let metric: TrafficMetric
    public let bucketStarts: [Date]
    public let bucketDuration: TimeInterval
    public let series: [TimelineSeries]
    public let total: Double
    public let observationsWithoutBytes: Int

    public var isEmpty: Bool { total <= 0 }

    /// True when the byte view is missing measurements, so the screen can say
    /// so instead of letting the gaps read as quiet periods.
    public var byteCoverageIsPartial: Bool {
        metric == .bytes && observationsWithoutBytes > 0
    }

    /// Total per bucket, for the stacked view's axis.
    public var bucketTotals: [Double] {
        (0..<bucketStarts.count).map { index in
            series.reduce(0) { $0 + ($1.values.indices.contains(index) ? $1.values[index] : 0) }
        }
    }
}

/// Turns per-bucket per-application totals into a fixed set of series.
public struct TimelineAggregator: Sendable {
    /// More lines than this and the legend stops being readable; the rest fold
    /// into the remainder rather than being dropped.
    public static let defaultLimit = 6

    public let remainderName: String
    private let limit: Int

    public init(limit: Int = TimelineAggregator.defaultLimit, remainderName: String = "Other") {
        self.limit = max(1, limit)
        self.remainderName = remainderName
    }

    public func aggregate(
        _ rows: [AppTimelineTotal],
        selection: VisualizationSelection
    ) -> TimelineModel {
        let bucketCount = VisualizationSelection.bucketCount
        let start = selection.start
        let width = selection.bucketDuration
        let bucketStarts = (0..<bucketCount).map {
            start.addingTimeInterval(width * Double($0))
        }
        let unknown = rows.reduce(0) { $0 + $1.observationsWithoutBytes }

        let weighted = rows.compactMap { row -> (app: String, bucket: Int, value: Double)? in
            guard row.bucketIndex >= 0, row.bucketIndex < bucketCount else { return nil }
            let value = selection.metric == .sessions
                ? Double(row.sessionCount)
                : Double(row.bytes)
            // Nothing measured is not the same as nothing sent, so it does not
            // become a zero-height band in the chart.
            guard value > 0 else { return nil }
            return (row.processName, row.bucketIndex, value)
        }

        guard !weighted.isEmpty else {
            return TimelineModel(
                metric: selection.metric,
                bucketStarts: bucketStarts,
                bucketDuration: width,
                series: [],
                total: 0,
                observationsWithoutBytes: unknown
            )
        }

        var appTotals: [String: Double] = [:]
        for entry in weighted {
            appTotals[entry.app, default: 0] += entry.value
        }
        // Ties break by name so the legend keeps its order between refreshes.
        let kept = Set(
            appTotals.sorted { ($0.value, $1.key) > ($1.value, $0.key) }
                .prefix(limit)
                .map(\.key)
        )

        var buckets: [String: [Double]] = [:]
        for entry in weighted {
            let name = kept.contains(entry.app) ? entry.app : remainderName
            buckets[name, default: Array(repeating: 0, count: bucketCount)][entry.bucket] += entry.value
        }

        let series = buckets
            .map { TimelineSeries(name: $0.key, values: $0.value, isRemainder: $0.key == remainderName) }
            // The remainder sits last however large it is: it is a residue, not
            // an application.
            .sorted {
                if $0.isRemainder != $1.isRemainder { return !$0.isRemainder }
                return ($0.total, $1.name) > ($1.total, $0.name)
            }

        return TimelineModel(
            metric: selection.metric,
            bucketStarts: bucketStarts,
            bucketDuration: width,
            series: series,
            total: weighted.reduce(0) { $0 + $1.value },
            observationsWithoutBytes: unknown
        )
    }
}

public extension TimelineModel {
    /// One sentence describing the chart, for anyone who cannot see it.
    func accessibilitySummary(
        empty: String,
        headline: (_ seriesCount: Int, _ total: Double, _ metric: TrafficMetric) -> String,
        busiest: (_ app: String, _ share: Int, _ bucketStart: Date) -> String
    ) -> String {
        guard !isEmpty, let top = series.first else { return empty }
        let peakIndex = bucketTotals.enumerated().max { $0.element < $1.element }?.offset ?? 0
        let share = Int((top.total / total * 100).rounded())
        let peak = bucketStarts.indices.contains(peakIndex) ? bucketStarts[peakIndex] : bucketStarts[0]
        return headline(series.count, total, metric) + " " + busiest(top.name, share, peak)
    }
}
