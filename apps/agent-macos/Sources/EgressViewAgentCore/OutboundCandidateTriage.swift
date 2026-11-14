import Foundation

/// What the person decided about one candidate (P3-194 phase 1).
///
/// Two answers, not three. A candidate states that this Mac sent more than
/// usual, which is a fact and so cannot be "a false positive"; what the person
/// can say is whether it matters to them. On one Mac, all nine candidates of
/// 2026-11-05..14 were the person's own apps, and how often the answer is
/// `expected` is what decides whether the list may ever notify.
public enum OutboundCandidateVerdict: String, Sendable, CaseIterable {
    /// The person recognises it: their own upload, sync or update.
    case expected
    /// The person wants to look further.
    case investigate
}

/// Kept apart from the candidate, which is recomputed from the baseline every
/// time and is never changed by a judgment.
///
/// Stays on this Mac: not sent to the Hub, not given to an AI provider, not
/// written to the diagnostics report or a notification. A note can name
/// people and places.
public struct OutboundCandidateJudgment: Equatable, Sendable {
    public var candidateID: String
    public var candidateAt: Date
    public var verdict: OutboundCandidateVerdict
    public var note: String
    public var judgedAt: Date

    public init(
        candidateID: String, candidateAt: Date, verdict: OutboundCandidateVerdict,
        note: String = "", judgedAt: Date
    ) {
        self.candidateID = candidateID
        self.candidateAt = candidateAt
        self.verdict = verdict
        self.note = note
        self.judgedAt = judgedAt
    }
}

/// The connections behind one candidate, read from the raw history, and how
/// much of that time the Agent could see.
public struct OutboundCandidateEvidence: Equatable, Sendable {
    /// One destination name and address used by one app, summed over the
    /// window.
    public struct Flow: Equatable, Sendable, Identifiable {
        public var application: String
        public var hostname: String?
        public var address: String
        public var bytesOut: UInt64
        public var connections: Int
        public var firstAt: Date
        public var lastAt: Date

        public var id: String { "\(application)|\(hostname ?? "")|\(address)" }

        public init(
            application: String, hostname: String?, address: String, bytesOut: UInt64,
            connections: Int, firstAt: Date, lastAt: Date
        ) {
            self.application = application
            self.hostname = hostname
            self.address = address
            self.bytesOut = bytesOut
            self.connections = connections
            self.firstAt = firstAt
            self.lastAt = lastAt
        }
    }

    public var window: DateInterval
    /// Largest first, at most `OutboundCandidateEvidence.flowLimit`.
    public var flows: [Flow]
    /// How many there were before the limit.
    public var flowTotal: Int
    /// Bytes of all of them, not just the ones shown.
    public var bytesOut: UInt64
    /// Seconds of `window` the Agent was monitoring.
    public var monitoredSeconds: Int
    /// Of the connections in `window` the baseline counted, how many had a
    /// byte count. Nil when there were none.
    public var byteShare: Double?
    /// The raw history begins after `window` starts, so some of the
    /// connections have already been folded away and cannot be shown.
    public var rawHistoryIsPartial: Bool

    public static let flowLimit = 20

    public init(
        window: DateInterval, flows: [Flow], flowTotal: Int, bytesOut: UInt64,
        monitoredSeconds: Int, byteShare: Double?, rawHistoryIsPartial: Bool
    ) {
        self.window = window
        self.flows = flows
        self.flowTotal = flowTotal
        self.bytesOut = bytesOut
        self.monitoredSeconds = monitoredSeconds
        self.byteShare = byteShare
        self.rawHistoryIsPartial = rawHistoryIsPartial
    }

    /// Less than this and the amount shown may be well short of what left.
    public static let fullCoverageShare = 0.95

    /// Monitoring stopped for part of the window, or connections went
    /// without a byte count: what was sent may be more than shown.
    public var mayUndercount: Bool {
        Double(monitoredSeconds) < window.duration * Self.fullCoverageShare
            || (byteShare ?? 1) < Self.fullCoverageShare
            || rawHistoryIsPartial
    }
}

extension OutboundCandidateRules {
    /// A judgment is kept this long after its candidate leaves the list, so a
    /// candidate that returns after a short gap keeps its answer.
    public static let judgmentRetention: Double = 30 * 86_400

    /// The time a candidate was judged over: the day it was listed; for a
    /// new pair the week that led up to it, since its bytes were added up
    /// over that week; and for the whole Mac the day before as well, since
    /// its 24 hours are the ones ending on that day and start on the one
    /// before. Read on one day only, a real 9.5 GB day showed 444 MB.
    public static func evidenceWindow(for candidate: OutboundCandidate) -> DateInterval {
        let day = candidate.at.timeIntervalSince1970
        let start: Double
        switch candidate.kind {
        case .newPair: start = day - (newPairWindow - 86_400)
        case .machine: start = day - 23 * 3600
        case .aboveUsual: start = day
        }
        return DateInterval(
            start: Date(timeIntervalSince1970: start),
            end: Date(timeIntervalSince1970: day + 86_400)
        )
    }
}
