import Foundation

/// Where to put the top of the timeline's vertical axis.
///
/// Measured on 2026-09-07 with a 24-hour window in bytes: one bucket carried
/// 1.71 GB and every other hour of the day was drawn at effectively zero. The
/// card's heading is "when did traffic happen", and one spike answered it for
/// one hour and erased the other twenty-three (P3-87).
///
/// The same window in connections read fine, because connection counts do not
/// span orders of magnitude the way transferred bytes do.
///
/// So the axis is allowed to stop below the tallest bucket. **A clipped bucket
/// must say so** -- silently cutting a bar turns a drawing into a false one,
/// which is worse than the crowding it fixes. The caller marks it and the card
/// says what the real figure was.
public struct TimelineAxis: Equatable, Sendable {
    /// The value drawn at full height.
    public let top: Double
    /// Buckets taller than `top`, by index.
    public let clipped: [Int]
    /// The tallest bucket's real value, when something was clipped.
    public let peak: Double?

    public var hasClipping: Bool { !clipped.isEmpty }

    /// How far above the rest of the data a bucket must stand before the axis
    /// leaves it behind.
    ///
    /// Four times the next tallest. Not a measured optimum: the measured facts
    /// are one bucket at 1.71 GB against a day whose other hours sit near a
    /// few tens of megabytes, and connection counts that never needed this at
    /// all. Four is high enough that ordinary daily variation -- a busy hour
    /// against a quiet one -- is drawn as it is, and low enough to catch the
    /// case that erased a day.
    public static let outlierRatio: Double = 4

    /// - Parameter totals: each bucket's total, in bucket order.
    public static func fit(totals: [Double]) -> TimelineAxis {
        let positive = totals.filter { $0 > 0 }
        guard let highest = positive.max() else {
            return TimelineAxis(top: 0, clipped: [], peak: nil)
        }
        let rest = positive.filter { $0 < highest }
        guard let runnerUp = rest.max(), runnerUp > 0, highest >= runnerUp * outlierRatio else {
            // Nothing stands far enough out. Draw everything to scale, which is
            // what the connections view has always done.
            return TimelineAxis(top: highest, clipped: [], peak: nil)
        }
        // Leave the runner-up room to be read as itself rather than as a bar
        // pinned to the ceiling.
        let top = runnerUp * 1.25
        let clipped = totals.indices.filter { totals[$0] > top }
        return TimelineAxis(top: top, clipped: clipped, peak: highest)
    }
}
