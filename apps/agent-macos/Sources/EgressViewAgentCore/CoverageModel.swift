import Foundation

/// A stretch during which monitoring was known to be running. `end` is nil
/// while it is still running.
public struct CoverageSession: Equatable, Sendable {
    public let start: Date
    public let end: Date?

    public init(start: Date, end: Date?) {
        self.start = start
        self.end = end
    }
}

/// How much of a chart's period was actually watched.
///
/// Every chart in this app draws what was observed. Without this, an hour
/// nobody was watching and an hour with no traffic produce the same empty
/// chart, and the empty chart is read as "nothing happened" -- which is the one
/// conclusion the data cannot support. So the charts say what they do not know.
public struct CoverageSummary: Equatable, Sendable {
    /// Fraction of the period that was monitored, 0...1.
    public let share: Double
    /// First moment in the period that was monitored, if any.
    public let firstCovered: Date?
    /// Unwatched stretches inside the period, longest first.
    public let gaps: [DateInterval]
    /// True when monitoring started inside the period rather than before it, so
    /// connections already open at that moment were never seen.
    public let startedInsidePeriod: Bool

    public init(
        share: Double,
        firstCovered: Date?,
        gaps: [DateInterval],
        startedInsidePeriod: Bool
    ) {
        self.share = share
        self.firstCovered = firstCovered
        self.gaps = gaps
        self.startedInsidePeriod = startedInsidePeriod
    }

    public var isComplete: Bool { share >= 0.999 }
    public var isEmpty: Bool { share <= 0 }
}

public enum CoverageCalculator {
    /// Gaps shorter than this are not worth a sentence. A second between two
    /// sessions is a restart, not a hole in the record, and reporting it would
    /// train the user to ignore the message that matters.
    public static let negligibleGap: TimeInterval = 30

    public static func summarize(
        sessions: [CoverageSession],
        from: Date,
        to: Date,
        now: Date = Date()
    ) -> CoverageSummary {
        let total = to.timeIntervalSince(from)
        guard total > 0 else {
            return CoverageSummary(share: 0, firstCovered: nil, gaps: [], startedInsidePeriod: false)
        }

        // An open session runs up to now, never past the end of the period and
        // never into the future.
        let clipped: [DateInterval] = sessions.compactMap { session in
            let start = max(session.start, from)
            let end = min(session.end ?? now, to)
            guard end > start else { return nil }
            return DateInterval(start: start, end: end)
        }.sorted { $0.start < $1.start }

        var merged: [DateInterval] = []
        for interval in clipped {
            if let last = merged.last, interval.start <= last.end {
                merged[merged.count - 1] = DateInterval(
                    start: last.start, end: max(last.end, interval.end)
                )
            } else {
                merged.append(interval)
            }
        }

        let covered = merged.reduce(0.0) { $0 + $1.duration }

        var gaps: [DateInterval] = []
        var cursor = from
        for interval in merged {
            if interval.start > cursor {
                gaps.append(DateInterval(start: cursor, end: interval.start))
            }
            cursor = max(cursor, interval.end)
        }
        if cursor < to {
            gaps.append(DateInterval(start: cursor, end: to))
        }

        // Monitoring that began before the period covers its whole start; one
        // that began inside it missed whatever was already connected.
        let startedInside = sessions.contains { $0.start > from && $0.start <= to }

        return CoverageSummary(
            share: min(1, covered / total),
            firstCovered: merged.first?.start,
            gaps: gaps
                .filter { $0.duration > negligibleGap }
                .sorted { $0.duration > $1.duration },
            startedInsidePeriod: startedInside
        )
    }
}
