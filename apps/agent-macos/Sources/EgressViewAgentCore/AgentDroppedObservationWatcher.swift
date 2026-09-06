import Foundation

/// Whether observations were newly dropped since the last reading.
///
/// `queueOverflowCount` and `contractRejectedCount` are **cumulative**: they
/// carry what has been dropped for the life of the queue file, which survives
/// restarts. Telling the user "some observations were not queued" because a
/// counter is non-zero would raise the alarm on every launch for something
/// that happened weeks ago, and an alarm that fires on old news is one people
/// learn to close without reading.
///
/// So the first reading never reports a drop. It establishes what the counters
/// already were; only a later increase is news.
///
/// Extracted from `HubDeliveryController.render` on 2026-09-06 so the rule can
/// be tested. The real machine can show the first half of it -- this Mac
/// carried `contractRejectedCount = 7` across a restart and stayed quiet --
/// but the increase itself needs a queue to overflow, which on measured
/// traffic (12-28 observations a minute against a 10,000 limit) would take
/// between six and fourteen hours of a blocked Hub and would discard real
/// observations to prove a rule that fits in three lines.
public struct AgentDroppedObservationWatcher: Sendable, Equatable {
    private var lastTotal: Int?

    public init() {}

    /// The cumulative total this watcher last saw, or nil before the first
    /// reading. Exposed so a caller can tell "nothing seen yet" from "seen
    /// zero", which are the two states the first-reading rule turns on.
    public var lastObservedTotal: Int? { lastTotal }

    /// Records a reading and answers whether it is higher than the one before.
    ///
    /// Returns false on the first reading whatever the counters say.
    public mutating func observe(queueOverflowCount: Int, contractRejectedCount: Int) -> Bool {
        let total = queueOverflowCount + contractRejectedCount
        defer { lastTotal = total }
        guard let lastTotal else { return false }
        return total > lastTotal
    }
}
