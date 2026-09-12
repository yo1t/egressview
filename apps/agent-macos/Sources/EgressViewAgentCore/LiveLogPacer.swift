import Foundation

/// How often the connection log may re-read the store while following traffic.
///
/// Connections arrive in bursts -- a page load is dozens of flows inside a
/// second -- and the log must not read once per arrival. It must also not
/// simply read faster: the screen that replaced itself on a short timer is
/// the thing P3-106 turned into an outage on Windows, where frequent polling
/// of an expensive answer took the IPC listener down with it.
///
/// So arrivals are collapsed into at most one read per interval. The decision
/// lives here, apart from the window, because the alternative is a pair of
/// mutable variables inside a view model where the only way to ask whether
/// they are right is to watch a screen and count.
public struct LiveLogPacer {
    /// One second: how often observations can arrive at all.
    ///
    /// The System Extension hands its records over on a one-second drain, so
    /// a faster screen would re-read rows it already has. The floor is set by
    /// what can arrive rather than by what reading costs -- measured
    /// 2026-09-12, a 500-row page with its country lookup is 0.72 ms against a
    /// 20,000-row store, which is not what should decide this.
    public static let defaultInterval: TimeInterval = FullMonitoringXPC.drainInterval

    private let interval: TimeInterval
    private var isScheduled = false
    private var lastRefreshAt: Date

    public init(
        interval: TimeInterval = LiveLogPacer.defaultInterval,
        lastRefreshAt: Date = .distantPast
    ) {
        self.interval = max(0, interval)
        self.lastRefreshAt = lastRefreshAt
    }

    /// How long to wait before reading, or `nil` when a read is already
    /// pending.
    ///
    /// `nil` is the answer for every arrival in a burst after the first. A
    /// hundred connections in one second are one read, not a hundred queued
    /// ones.
    public mutating func schedule(now: Date = Date()) -> TimeInterval? {
        guard !isScheduled else { return nil }
        isScheduled = true
        return max(0, interval - now.timeIntervalSince(lastRefreshAt))
    }

    /// The scheduled read happened.
    public mutating func refreshed(at moment: Date = Date()) {
        isScheduled = false
        lastRefreshAt = moment
    }

    /// The scheduled read was abandoned -- the tab changed, the window closed,
    /// or the reader paused it.
    ///
    /// Without this the pacer would believe a read is forever pending and
    /// never schedule another, which is how a live screen quietly stops being
    /// live.
    public mutating func cancelled() {
        isScheduled = false
    }
}
