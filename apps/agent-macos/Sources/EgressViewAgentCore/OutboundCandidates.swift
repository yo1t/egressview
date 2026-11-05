import Foundation

/// Traffic worth a person's look, judged against this Mac's own usual level
/// (P3-192, P3-193 phase 2).
///
/// A list to read, not an alert: replayed over 18 days of one Mac it found
/// four pairs it could not explain and nothing it could call harmful, so this
/// says "look here" and never "this is bad". The thresholds come from that one
/// Mac and will move.
///
/// Worked out from the baseline tables each time rather than stored, so a
/// restart or a deleted stretch of history gives the answer the tables give.
public struct OutboundCandidate: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable {
        /// An app and destination not seen before learning finished.
        case newPair
        /// A known pair, far above its own usual day.
        case aboveUsual
        /// This Mac as a whole, far above its usual 24 hours.
        case machine
    }

    public var kind: Kind
    public var at: Date
    /// Nil for `.machine`.
    public var application: String?
    public var destination: String?
    public var bytesOut: UInt64
    /// What it is being compared with. Nil for `.newPair`, which has no past.
    public var usualBytesOut: UInt64?

    public var id: String { "\(kind.rawValue)|\(at.timeIntervalSince1970)|\(application ?? "")|\(destination ?? "")" }

    public init(
        kind: Kind, at: Date, application: String? = nil, destination: String? = nil,
        bytesOut: UInt64, usualBytesOut: UInt64? = nil
    ) {
        self.kind = kind
        self.at = at
        self.application = application
        self.destination = destination
        self.bytesOut = bytesOut
        self.usualBytesOut = usualBytesOut
    }
}

public struct OutboundCandidateReport: Equatable, Sendable {
    public enum State: Equatable, Sendable {
        /// Too few monitored hours to say what is usual. Not "all clear".
        case learning(monitoredHours: Double)
        /// Judged, but much of the traffic has no byte count, so an empty list
        /// says little.
        case lowByteCoverage(share: Double)
        case ready
    }

    public var state: State
    /// Newest first, at most `OutboundCandidateRules.listLimit`.
    public var candidates: [OutboundCandidate]
    public var total: Int

    public init(state: State, candidates: [OutboundCandidate] = [], total: Int = 0) {
        self.state = state
        self.candidates = candidates
        self.total = total
    }
}

public enum OutboundCandidateRules {
    public struct Hour: Equatable, Sendable {
        public var start: Double
        public var monitoredSeconds: Int
        public var bytesOut: UInt64
        public var observations: Int
        public var observationsWithBytes: Int

        public init(start: Double, monitoredSeconds: Int, bytesOut: UInt64, observations: Int = 0, observationsWithBytes: Int = 0) {
            self.start = start
            self.monitoredSeconds = monitoredSeconds
            self.bytesOut = bytesOut
            self.observations = observations
            self.observationsWithBytes = observationsWithBytes
        }
    }

    public struct PairKey: Hashable, Sendable {
        public var application: String
        public var destination: String

        public init(application: String, destination: String) {
            self.application = application
            self.destination = destination
        }
    }

    public struct PairDay: Equatable, Sendable {
        public var day: Double
        public var pair: PairKey
        public var bytesOut: UInt64

        public init(day: Double, pair: PairKey, bytesOut: UInt64) {
            self.day = day
            self.pair = pair
            self.bytesOut = bytesOut
        }
    }

    /// A week of monitored time, however many calendar days that took.
    public static let learningSeconds = 168 * 3600
    /// A new pair is added up over a week: judged on its first day alone, one
    /// that sends a little every day would never appear.
    public static let newPairBytes: UInt64 = 1 << 20
    public static let newPairWindow: Double = 7 * 86_400
    public static let aboveUsualBytes: UInt64 = 10 << 20
    public static let aboveUsualFactor: UInt64 = 5
    public static let aboveUsualMinimumDays = 3
    public static let machineFactor = 1.5
    public static let machineMinimumWindows = 168
    /// Not measured yet: 98.8% on a Mac counting from packet headers, and
    /// about 19% of TCP without them.
    public static let lowByteCoverageShare = 0.8
    public static let coverageHours = 168
    public static let listWindow: Double = 14 * 86_400
    /// Enough that fourteen days on a busy Mac are not cut short. The view
    /// opens with `AgentOutboundCandidatesView.collapsedCount` of these.
    public static let listLimit = 50

    /// Browsers go to new places for a living and a virtual machine hides what
    /// runs inside it: 220 of 415 new pairs in the replay. Neither can be told
    /// apart by this rule, so the list says so instead of pretending.
    private static let unattributablePrefixes = [
        "Google Chrome", "com.google.Chrome", "Safari", "com.apple.Safari", "com.apple.WebKit",
        "firefox", "org.mozilla.firefox", "Microsoft Edge", "com.microsoft.edgemac",
        "Brave Browser", "com.brave.Browser", "company.thebrowser.Browser", "Opera", "Vivaldi",
        "vmnet-natd", "com.apple.Virtualization", "Docker", "com.docker", "qemu",
    ]
    private static let unattributableNames: Set<String> = ["Arc", "Arc Helper", "UTM"]

    public static func isUnattributable(application: String) -> Bool {
        unattributableNames.contains(application)
            || unattributablePrefixes.contains { application.hasPrefix($0) }
    }

    public static func evaluate(
        hours: [Hour], pairDays: [PairDay], firstSeen: [PairKey: Double], now: Date
    ) -> OutboundCandidateReport {
        let ordered = hours.sorted { $0.start < $1.start }
        var monitored = 0
        var learnedAt: Double?
        for hour in ordered {
            monitored += hour.monitoredSeconds
            if monitored >= learningSeconds {
                learnedAt = hour.start + 3600
                break
            }
        }
        guard let learnedAt else {
            return OutboundCandidateReport(state: .learning(monitoredHours: Double(monitored) / 3600))
        }
        var found = newPairs(pairDays, firstSeen: firstSeen, learnedAt: learnedAt)
        found += aboveUsual(pairDays, learnedAt: learnedAt)
        found += machine(ordered, learnedAt: learnedAt)
        let cutoff = now.timeIntervalSince1970 - listWindow
        let recent = found.filter { $0.at.timeIntervalSince1970 >= cutoff }
            .sorted { ($0.at, $0.id) > ($1.at, $1.id) }

        let latest = ordered.suffix(coverageHours)
        let observations = latest.reduce(0) { $0 + $1.observations }
        let withBytes = latest.reduce(0) { $0 + $1.observationsWithBytes }
        let share = observations == 0 ? 0 : Double(withBytes) / Double(observations)
        return OutboundCandidateReport(
            state: share < lowByteCoverageShare ? .lowByteCoverage(share: share) : .ready,
            candidates: Array(recent.prefix(listLimit)), total: recent.count
        )
    }

    private static func grouped(_ pairDays: [PairDay]) -> [PairKey: [PairDay]] {
        Dictionary(grouping: pairDays, by: \.pair).mapValues { $0.sorted { $0.day < $1.day } }
    }

    private static func newPairs(
        _ pairDays: [PairDay], firstSeen: [PairKey: Double], learnedAt: Double
    ) -> [OutboundCandidate] {
        var found: [OutboundCandidate] = []
        for (pair, days) in grouped(pairDays) {
            guard let first = firstSeen[pair], first >= learnedAt,
                  !isUnattributable(application: pair.application) else { continue }
            var sent: UInt64 = 0
            for day in days where day.day + 86_400 > first && day.day < first + newPairWindow {
                sent = sent.addingReportingOverflow(day.bytesOut).partialValue
                if sent >= newPairBytes {
                    found.append(OutboundCandidate(
                        kind: .newPair, at: Date(timeIntervalSince1970: day.day),
                        application: pair.application, destination: pair.destination, bytesOut: sent
                    ))
                    break
                }
            }
        }
        return found
    }

    /// Against the 90th percentile, and without the days already listed: with
    /// the largest day as the yardstick, one 8.6 GiB send hid everything under
    /// 25 GiB from then on.
    private static func aboveUsual(_ pairDays: [PairDay], learnedAt: Double) -> [OutboundCandidate] {
        var found: [OutboundCandidate] = []
        for (pair, days) in grouped(pairDays) {
            var usual: [UInt64] = []
            for day in days {
                if day.day + 86_400 > learnedAt, usual.count >= aboveUsualMinimumDays {
                    let yardstick = percentile(usual.sorted(), 0.9)
                    let (limit, overflow) = yardstick.multipliedReportingOverflow(by: aboveUsualFactor)
                    if !overflow, day.bytesOut >= aboveUsualBytes, day.bytesOut >= limit {
                        found.append(OutboundCandidate(
                            kind: .aboveUsual, at: Date(timeIntervalSince1970: day.day),
                            application: pair.application, destination: pair.destination,
                            bytesOut: day.bytesOut, usualBytesOut: yardstick
                        ))
                        continue
                    }
                }
                usual.append(day.bytesOut)
            }
        }
        return found
    }

    /// Over the last 24 fully monitored hours. One entry a day, for the
    /// largest window: a single burst stays in the sum for 24 hours.
    private static func machine(_ ordered: [Hour], learnedAt: Double) -> [OutboundCandidate] {
        let full = ordered.filter { $0.monitoredSeconds >= OutboundBaselineSummary.fullyMonitoredSeconds }
        guard full.count >= 24 else { return [] }
        var usual: [UInt64] = []
        var waiting: [(start: Double, sent: UInt64)] = []
        var byDay: [Double: OutboundCandidate] = [:]
        var sum = full[..<23].reduce(UInt64(0)) { $0 &+ $1.bytesOut }
        for index in 23..<full.count {
            sum &+= full[index].bytesOut
            let start = full[index].start
            // A window overlaps the ones just before it, so it joins the
            // comparison only a day later.
            while let next = waiting.first, start - next.start >= 86_400 {
                insert(next.sent, into: &usual)
                waiting.removeFirst()
            }
            let yardstick = usual.isEmpty ? 0 : percentile(usual, 0.99)
            if start >= learnedAt, usual.count >= machineMinimumWindows,
               Double(sum) > machineFactor * Double(yardstick) {
                let day = (start / 86_400).rounded(.down) * 86_400
                if sum > byDay[day]?.bytesOut ?? 0 {
                    byDay[day] = OutboundCandidate(
                        kind: .machine, at: Date(timeIntervalSince1970: day),
                        bytesOut: sum, usualBytesOut: yardstick
                    )
                }
            } else {
                waiting.append((start, sum))
            }
            sum &-= full[index - 23].bytesOut
        }
        return Array(byDay.values)
    }

    private static func insert(_ value: UInt64, into sorted: inout [UInt64]) {
        var low = 0, high = sorted.count
        while low < high {
            let middle = (low + high) / 2
            if sorted[middle] < value { low = middle + 1 } else { high = middle }
        }
        sorted.insert(value, at: low)
    }

    private static func percentile(_ sorted: [UInt64], _ p: Double) -> UInt64 {
        sorted[Int(p * Double(sorted.count - 1))]
    }
}
