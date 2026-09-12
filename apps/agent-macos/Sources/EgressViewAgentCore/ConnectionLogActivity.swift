import Foundation

/// Whether a row in the connection log is still happening.
///
/// The log shows one row per flow, and that row keeps being updated while the
/// traffic continues: its last-observed time moves forward. A column headed
/// with an end time that silently keeps changing is worse than no column --
/// a connection that finished and one that is still running would look the
/// same (P3-107).
///
/// What can honestly be said is narrower than "the connection is open". The
/// agent does not watch connections open and close; it samples the socket
/// table, so the only fact available is **when this flow was last seen**. A
/// flow last seen in the most recent sample was still there when the snapshot
/// was taken, and that is what this reports.
public enum ConnectionLogActivity {
    /// How far behind the snapshot a flow may be and still count as running.
    ///
    /// Three sampling intervals. One would be the theoretical answer and is
    /// the wrong one: the sampler is a `DispatchSourceTimer`, a sample takes
    /// time to walk the socket table, and the timestamp written is from
    /// inside that walk. Three leaves room for that without reaching so far
    /// back that a finished connection stays lit.
    ///
    /// Derived from the sampler's own interval rather than written as a
    /// number, so changing the sampling rate cannot leave this behind.
    public static var runningTolerance: TimeInterval { LightweightCollector.defaultInterval * 3 }

    /// Was this flow still being seen when the snapshot was taken?
    ///
    /// Measured against the snapshot, never against the wall clock. The window
    /// refreshes on its own timer, so "now" drifts up to a whole refresh
    /// interval away from the data -- and a marker that switched off while
    /// nothing changed on the Mac would be reporting the refresh timer, not
    /// the connection.
    public static func isRunning(lastObservedAt: Date, snapshotTakenAt: Date) -> Bool {
        let age = snapshotTakenAt.timeIntervalSince(lastObservedAt)
        // A negative age is a flow stamped after the snapshot was taken, which
        // happens when a sample lands mid-read. It is running, not impossible.
        return age >= -runningTolerance && age <= runningTolerance
    }
}
