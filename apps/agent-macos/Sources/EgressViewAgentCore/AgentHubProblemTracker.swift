import Foundation

/// Whether the user has actually been told about the current Hub problem, and
/// whether it is worth trying again.
///
/// The delivery state is published, and the notifier subscribes with
/// `removeDuplicates()`: it hears about a problem once, when the state changes.
/// If that one attempt is refused -- the per-cause cooldown allows one an hour
/// -- there is no second attempt, because the state does not change again while
/// the problem persists.
///
/// Measured on 2026-09-07: a Hub blocked for **eighty-eight minutes**, 1,203
/// observations queued, 141 retries, and **not one "delivery is delayed"
/// notification**. The state did reach `.unavailable` -- the recovery message
/// that followed proves it, since that one only fires after a problem state --
/// but the single attempt landed inside a cooldown started ten minutes before
/// the outage, and nothing tried again (P3-88).
///
/// **The longer an outage lasts, the less likely it is to be reported**, which
/// is the wrong way round. And the user was then told delivery had recovered
/// from a problem they were never told about.
///
/// So two rules. A problem that has not been announced is retried while it
/// lasts, and a recovery is announced only for a problem that was.
public struct AgentHubProblemTracker: Sendable, Equatable {
    private var activeProblem: String?
    private var announced = false

    public init() {}

    /// Whether an unannounced problem is currently outstanding.
    public var hasUnannouncedProblem: Bool { activeProblem != nil && !announced }

    /// Records that the delivery state names a problem.
    ///
    /// - Parameter cause: the notification key for it. A different cause is a
    ///   different problem and starts over -- an authorisation failure is not
    ///   the same news as a retry, and having announced one says nothing about
    ///   the other.
    /// - Returns: whether to attempt a notification now.
    public mutating func problem(cause: String) -> Bool {
        if activeProblem != cause {
            activeProblem = cause
            announced = false
        }
        return !announced
    }

    /// Records the outcome of an attempt. Only a delivered notification counts
    /// as having told the user; one the limiter refused did not reach them.
    public mutating func attempted(delivered: Bool) {
        if delivered { announced = true }
    }

    /// Whether to try announcing the outstanding problem again.
    ///
    /// Called on a timer rather than on a state change, because the state does
    /// not change while a problem persists -- which is exactly why the first
    /// attempt was the only one.
    public mutating func shouldRetryAnnouncement() -> (retry: Bool, cause: String?) {
        guard let activeProblem, !announced else { return (false, nil) }
        return (true, activeProblem)
    }

    /// Whether a recovery is worth saying.
    ///
    /// Only for a problem the user heard about. Otherwise "delivery recovered"
    /// arrives for something they were never told had broken, which is the
    /// shape of the defect this exists to stop rather than a fix for it.
    public mutating func recovered() -> Bool {
        defer { activeProblem = nil; announced = false }
        return activeProblem != nil && announced
    }

    /// Delivery stopped being a question -- switched off, paused, no path.
    /// Nothing outstanding, and nothing to announce later.
    public mutating func inactive() {
        activeProblem = nil
        announced = false
    }
}
