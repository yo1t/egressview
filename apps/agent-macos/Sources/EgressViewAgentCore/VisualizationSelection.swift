import Foundation

/// How wide a window the charts are showing.
public enum TimeScale: String, Equatable, Sendable, CaseIterable {
    case hour
    case sixHours
    case day
    case week
    case month

    public var duration: TimeInterval {
        switch self {
        case .hour: return 3_600
        case .sixHours: return 6 * 3_600
        case .day: return 86_400
        case .week: return 7 * 86_400
        case .month: return 30 * 86_400
        }
    }

    public var retentionDaysRequired: Int {
        switch self {
        case .hour, .sixHours, .day: return 1
        case .week: return 7
        case .month: return 30
        }
    }
}

/// The period and metric that the sankey, the globe map and the timeline all
/// read from.
///
/// One place holds it on purpose. Three charts each keeping their own period
/// will drift apart, and the moment they do, "which app caused that spike, and
/// where was it going" stops being answerable — the user would have to select
/// the same window three times, so they simply will not.
public struct VisualizationSelection: Equatable, Sendable {
    /// Enough points to show a shape, few enough that a month costs the same
    /// as an hour to draw.
    public static let bucketCount = 60

    public let scale: TimeScale
    public let metric: TrafficMetric
    /// End of the window. Held explicitly so a selection stays put while the
    /// user compares charts, instead of sliding with the clock.
    public let end: Date

    public init(scale: TimeScale = .day, metric: TrafficMetric = .sessions, end: Date = Date()) {
        self.scale = scale
        self.metric = metric
        self.end = end
    }

    public var start: Date { end.addingTimeInterval(-scale.duration) }
    public var bucketDuration: TimeInterval { scale.duration / Double(Self.bucketCount) }

    /// The scales that the stored history can actually cover.
    ///
    /// Offering a month to someone keeping one day of history would draw
    /// twenty-nine empty buckets and call it their traffic.
    public static func availableScales(retention: ObservationRetention) -> [TimeScale] {
        TimeScale.allCases.filter { $0.retentionDaysRequired <= retention.retentionDays }
    }

    /// The metrics worth offering.
    ///
    /// Byte counts arrive only when a flow closes, so a history with none
    /// measured yet must not offer a view that would be blank in every bucket.
    public static func availableMetrics(hasMeasuredBytes: Bool) -> [TrafficMetric] {
        hasMeasuredBytes ? TrafficMetric.allCases : [.sessions]
    }

    /// Keeps the selection inside what the history can answer. Both values are
    /// corrected together so the charts never show a scale the data cannot
    /// fill, nor a metric it cannot measure.
    public func clamped(
        retention: ObservationRetention,
        hasMeasuredBytes: Bool
    ) -> VisualizationSelection {
        let scales = Self.availableScales(retention: retention)
        let metrics = Self.availableMetrics(hasMeasuredBytes: hasMeasuredBytes)
        return VisualizationSelection(
            scale: scales.contains(scale) ? scale : (scales.last ?? .hour),
            metric: metrics.contains(metric) ? metric : .sessions,
            end: end
        )
    }

    /// Narrows to a range the user dragged out on the timeline, keeping the
    /// metric. The charts follow the selection; the selection does not reset
    /// what the user was looking at.
    public func selecting(from: Date, to: Date) -> VisualizationSelection {
        let span = max(60, to.timeIntervalSince(from))
        let scale = TimeScale.allCases.min {
            abs($0.duration - span) < abs($1.duration - span)
        } ?? scale
        return VisualizationSelection(scale: scale, metric: metric, end: to)
    }
}
