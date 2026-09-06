import Foundation

/// Whether Hub delivery may be described to the user as working, and whether a
/// problem has lasted long enough to be worth saying out loud.
///
/// Two defects on 2026-09-06 come from the same place, and they fail in
/// opposite directions.
///
/// **P3-85.** The controller read the sender being `.idle` as delivery being
/// healthy. `.idle` means "not sending right now"; between retry waits a sender
/// that has delivered nothing for hours passes through it. With the Hub
/// deliberately unreachable for nine hours and thirty-six minutes -- zero
/// batches accepted, 7,981 observations queued -- the agent told the user "Hub
/// delivery has recovered. The queued observations can be sent again" **eight
/// times**. Nothing had been sent.
///
/// **P3-68.** The opposite: a failure that resolves in seconds became a pair of
/// alarms every time. Two thirds of one day's notifications were a "delivery
/// delayed" and a "recovered" for hiccups whose longest measured gap in
/// accepted batches was thirty-three seconds.
///
/// So health is judged by an acknowledgement rather than by a state name, and a
/// problem has to persist before it is reported. Neither rule is about how the
/// screen reads: one stops the agent claiming delivery that did not happen, the
/// other stops it crying wolf until the user stops reading.
public struct AgentDeliveryHealthEvaluator: Sendable, Equatable {
    public enum Verdict: Sendable, Equatable {
        /// Delivery is demonstrably working: the Hub acknowledged something.
        case healthy
        /// A problem that has lasted long enough to be worth reporting.
        case unavailable
        /// A problem too young to report. The caller says nothing and waits.
        case settling
        /// Delivery is off, paused, or has no network path. Not an alarm.
        case inactive
    }

    /// How long a problem must persist before it is reported.
    ///
    /// Five minutes, not a measured optimum. The measured facts are that the
    /// hiccups resolve within thirty-three seconds and that a real outage ran
    /// for hours, so anything between those separates them; five minutes sits
    /// there with room on both sides. It is a starting value, and the reason it
    /// is not smaller is that a shorter window buys nothing a user can act on.
    public static let defaultGrace: TimeInterval = 300

    private let grace: TimeInterval
    private var lastAcknowledged: Date?
    private var problemSince: Date?

    public init(grace: TimeInterval = AgentDeliveryHealthEvaluator.defaultGrace) {
        self.grace = grace
    }

    /// The acknowledgement this evaluator last saw, or nil before the first
    /// reading. Exposed so a caller can tell "nothing seen yet" from "seen and
    /// unchanged".
    public var lastObservedAcknowledgement: Date? { lastAcknowledged }

    /// - Parameters:
    ///   - isDelivering: the sender is enabled and either idle or sending --
    ///     that is, nothing is currently wrong with it.
    ///   - isProblem: the sender is retrying, failed, or unauthorised.
    ///   - isInactive: delivery is off, paused, or waiting for a network path.
    ///   - pendingCount: observations still waiting to be delivered.
    ///   - lastAcknowledgedAt: when the Hub last acknowledged a batch.
    public mutating func evaluate(
        isDelivering: Bool,
        isProblem: Bool,
        isInactive: Bool,
        pendingCount: Int,
        lastAcknowledgedAt: Date?,
        now: Date = Date()
    ) -> Verdict {
        let acknowledgementAdvanced = Self.advanced(from: lastAcknowledged, to: lastAcknowledgedAt)
        defer { lastAcknowledged = lastAcknowledgedAt ?? lastAcknowledged }

        if isInactive {
            problemSince = nil
            return .inactive
        }
        if isProblem {
            let since = problemSince ?? now
            problemSince = since
            return now.timeIntervalSince(since) >= grace ? .unavailable : .settling
        }
        // Not a problem, but "not a problem" is not evidence of delivery. Say
        // healthy only when the Hub has answered: either there is nothing left
        // to send, or an acknowledgement arrived since the last reading.
        guard isDelivering else {
            problemSince = nil
            return .inactive
        }
        if pendingCount == 0 || acknowledgementAdvanced {
            problemSince = nil
            return .healthy
        }
        // Work is queued and nothing has been acknowledged since we last
        // looked. That is the state the agent used to call "recovered".
        let since = problemSince ?? now
        problemSince = since
        return now.timeIntervalSince(since) >= grace ? .unavailable : .settling
    }

    private static func advanced(from previous: Date?, to current: Date?) -> Bool {
        guard let current else { return false }
        guard let previous else { return true }
        return current > previous
    }
}
