import Foundation

/// One entry from a threat feed.
public struct ThreatIndicator: Equatable, Sendable {
    public enum Kind: String, Sendable, CaseIterable {
        case ip
        case domain
        case cidr
    }

    /// How much a match means, matching what the Hub decides (P3-19).
    ///
    /// URLhaus lists the URL where malware was hosted, so a match on
    /// `github.com` or `s3.amazonaws.com` says something was hosted there --
    /// not that the domain is hostile. Treating those the same as a C2 address
    /// means the ordinary use of ordinary services raises alarms, and a person
    /// who is warned about Google Drive every day stops reading warnings.
    ///
    /// The Hub has made this distinction since P2-71. The Agent did not, so a
    /// Mac away from its Hub judged the same destination differently from the
    /// Hub judging it -- which the completion criteria for P3-19 rule out.
    public enum Confidence: String, Sendable, CaseIterable {
        case high
        case low
    }

    public let kind: Kind
    /// The address, domain or CIDR the feed listed.
    public let value: String
    public let source: String?
    public let tag: String?
    public let confidence: Confidence

    public init(
        kind: Kind, value: String, source: String?, tag: String?,
        confidence: Confidence = .high
    ) {
        self.kind = kind
        self.value = value
        self.confidence = confidence
        self.source = source
        self.tag = tag
    }
}

/// What matched, and how.
public struct ThreatMatch: Equatable, Sendable {
    public let indicator: ThreatIndicator
    /// The exact string that matched, which is not always the destination:
    /// `evil.bad.example` matches a listing for `bad.example`, and the user
    /// needs to see which one was on the list.
    public let matchedValue: String

    public init(indicator: ThreatIndicator, matchedValue: String) {
        self.indicator = indicator
        self.matchedValue = matchedValue
    }
}

/// Decides whether a destination appears in the indicator set.
///
/// Deliberately the same three steps, in the same order, as the Hub's
/// `matchThreatIntel`: exact address, then the hostname and each of its parent
/// domains, then IPv4 CIDR. Two implementations that disagree would give the
/// same connection two verdicts depending on where it was looked at, and the
/// operator would have to work out which to believe.
public struct ThreatMatcher: Sendable {
    private let ips: [String: ThreatIndicator]
    private let domains: [String: ThreatIndicator]
    private let cidrs: [(network: UInt32, mask: UInt32, indicator: ThreatIndicator)]

    public var isEmpty: Bool { ips.isEmpty && domains.isEmpty && cidrs.isEmpty }
    public var count: Int { ips.count + domains.count + cidrs.count }

    public init(indicators: [ThreatIndicator]) {
        var ips: [String: ThreatIndicator] = [:]
        var domains: [String: ThreatIndicator] = [:]
        var cidrs: [(UInt32, UInt32, ThreatIndicator)] = []
        for indicator in indicators {
            switch indicator.kind {
            case .ip:
                ips[indicator.value] = indicator
            case .domain:
                domains[indicator.value.lowercased()] = indicator
            case .cidr:
                if let parsed = Self.parseCIDR(indicator.value) {
                    cidrs.append((parsed.network, parsed.mask, indicator))
                }
            }
        }
        self.ips = ips
        self.domains = domains
        self.cidrs = cidrs.map { (network: $0.0, mask: $0.1, indicator: $0.2) }
    }

    public func match(address: String, hostname: String?) -> ThreatMatch? {
        if let hit = ips[address] {
            return ThreatMatch(indicator: hit, matchedValue: address)
        }

        if let hostname, !hostname.isEmpty, hostname != address {
            let lowered = hostname.lowercased()
            if let hit = domains[lowered] {
                return ThreatMatch(indicator: hit, matchedValue: lowered)
            }
            // `evil.bad.example` must match a listing for `bad.example`. The
            // walk stops at two labels, which is not the same as knowing about
            // public suffixes: a feed listing `co.uk` would match every host
            // under it. That is inherited from the Hub deliberately -- one
            // connection must not get two verdicts depending on where it was
            // checked -- so if it needs fixing, both sides move together.
            let parts = lowered.split(separator: ".").map(String.init)
            if parts.count > 2 {
                for index in 1...(parts.count - 2) {
                    let parent = parts[index...].joined(separator: ".")
                    if let hit = domains[parent] {
                        return ThreatMatch(indicator: hit, matchedValue: parent)
                    }
                }
            }
        }

        // IPv4 only. The feeds that carry CIDRs do not publish IPv6 ranges, and
        // pretending to check them would be worse than not checking.
        if !cidrs.isEmpty, let number = Self.ipv4ToNumber(address) {
            for entry in cidrs where (number & entry.mask) == entry.network {
                return ThreatMatch(indicator: entry.indicator, matchedValue: entry.indicator.value)
            }
        }

        return nil
    }

    static func ipv4ToNumber(_ address: String) -> UInt32? {
        guard !address.contains(":") else { return nil }
        let parts = address.split(separator: ".")
        guard parts.count == 4 else { return nil }
        var result: UInt32 = 0
        for part in parts {
            guard let octet = UInt32(part), octet <= 255 else { return nil }
            result = (result << 8) | octet
        }
        return result
    }

    static func parseCIDR(_ text: String) -> (network: UInt32, mask: UInt32)? {
        let parts = text.split(separator: "/")
        guard parts.count == 2,
              let base = ipv4ToNumber(String(parts[0])),
              let prefix = UInt32(parts[1]), prefix <= 32
        else { return nil }
        let mask: UInt32 = prefix == 0 ? 0 : ~UInt32(0) << (32 - prefix)
        return (base & mask, mask)
    }
}

/// Why the screen has no threat information, which is not the same as having
/// found none.
public enum ThreatIntelAvailability: Equatable, Sendable {
    /// Indicators are loaded and the period was checked.
    case checked(indicatorCount: Int, fetchedAt: Date?)
    /// No Hub, and direct feed downloads are switched off.
    case notEnabled
    /// The Hub is configured but has no feeds of its own.
    case hubHasNoFeeds
    /// Enabled, but nothing has arrived yet.
    case notFetchedYet
}

/// A destination seen in the period, ready to be checked against the
/// indicators.
public struct ThreatCandidate: Equatable, Sendable {
    public let address: String
    public let hostname: String?
    public let processName: String
    public let sessionCount: Int
    public let lastObservedAt: Date
    public let firstObservedAt: Date
    /// Bytes both ways, over the connections that reported any.
    public let bytes: UInt64
    /// How many of those connections never reported a byte count, so the
    /// figure above can be shown as a floor rather than a total.
    public let observationsWithoutBytes: Int

    public init(
        address: String, hostname: String?, processName: String,
        sessionCount: Int, lastObservedAt: Date,
        firstObservedAt: Date = Date(timeIntervalSince1970: 0),
        bytes: UInt64 = 0, observationsWithoutBytes: Int = 0
    ) {
        self.address = address
        self.hostname = hostname
        self.processName = processName
        self.sessionCount = sessionCount
        self.lastObservedAt = lastObservedAt
        self.firstObservedAt = firstObservedAt
        self.bytes = bytes
        self.observationsWithoutBytes = observationsWithoutBytes
    }

    /// True when some connections never reported bytes, so the total is a
    /// lower bound. Byte counts arrive when a connection closes.
    public var bytesArePartial: Bool { observationsWithoutBytes > 0 }
}

/// One destination in the period that appears in a threat feed.
public struct ThreatFinding: Equatable, Sendable, Identifiable {
    public let candidate: ThreatCandidate
    public let match: ThreatMatch

    /// Unique per row the threat table can show.
    ///
    /// The host name belongs here because candidates are grouped by it:
    /// one address reached by one app appears twice whenever a name was
    /// resolved for some of its connections and not others, which is ordinary
    /// -- names arrive from SNI after the flow opens. Leaving it out gave both
    /// rows the same id, and SwiftUI reported `ForEach` producing undefined
    /// results (P3-53).
    public var id: String {
        "\(candidate.address)|\(candidate.hostname ?? "")|\(candidate.processName)|\(match.matchedValue)"
    }

    /// How much this match means. Reads through to the indicator so the
    /// screen and the notifier cannot disagree about it.
    public var confidence: ThreatIndicator.Confidence { match.indicator.confidence }

    public init(candidate: ThreatCandidate, match: ThreatMatch) {
        self.candidate = candidate
        self.match = match
    }
}

/// The threats found in a period, and whether anyone was in a position to look.
public struct ThreatReport: Equatable, Sendable {
    public let findings: [ThreatFinding]
    public let availability: ThreatIntelAvailability

    public init(findings: [ThreatFinding], availability: ThreatIntelAvailability) {
        self.findings = findings
        self.availability = availability
    }

    /// Distinct destinations, which is what the count on screen means. Counting
    /// findings would inflate it: one bad address reached by three apps is one
    /// destination to worry about, not three.
    public var destinationCount: Int {
        Set(findings.map(\.candidate.address)).count
    }

    /// Destinations whose match is worth acting on, separated from the ones
    /// that only say a file was hosted on a service people use all day.
    ///
    /// Counting them together is how a person learns to ignore the number
    /// (P3-19): if Google Drive raises the same alarm as a C2 address, the
    /// alarm stops meaning anything.
    ///
    /// An address is low confidence only when **nothing** about it is high.
    /// One high-confidence match is enough to make the destination worth
    /// looking at, whatever else also matched it.
    public var highConfidenceAddresses: Set<String> {
        Set(findings.filter { $0.confidence == .high }.map(\.candidate.address))
    }

    public var lowConfidenceAddresses: Set<String> {
        Set(findings.map(\.candidate.address)).subtracting(highConfidenceAddresses)
    }

    public var highConfidenceDestinationCount: Int { highConfidenceAddresses.count }
    public var lowConfidenceDestinationCount: Int { lowConfidenceAddresses.count }

    /// True only when indicators were actually loaded. An empty list from a
    /// screen that never had indicators is not "no threats".
    public var wasChecked: Bool {
        if case .checked = availability { return true }
        return false
    }

    public static func evaluate(
        candidates: [ThreatCandidate],
        matcher: ThreatMatcher,
        availability: ThreatIntelAvailability
    ) -> ThreatReport {
        guard case .checked = availability else {
            return ThreatReport(findings: [], availability: availability)
        }
        var findings: [ThreatFinding] = []
        for candidate in candidates {
            guard let match = matcher.match(
                address: candidate.address, hostname: candidate.hostname
            ) else { continue }
            findings.append(ThreatFinding(candidate: candidate, match: match))
        }
        // Busiest first: a destination reached hundreds of times is a different
        // problem from one reached once.
        findings.sort { $0.candidate.sessionCount > $1.candidate.sessionCount }
        return ThreatReport(findings: findings, availability: availability)
    }
}

/// Where the indicators come from, and the one rule that decides it.
///
/// This rule picks the primary source from **enrolment**, never reachability.
/// An explicitly approved fallback is evaluated separately by
/// `ThreatIntelFallbackPolicy`; keeping those decisions separate prevents Hub
/// downtime alone from silently starting third-party traffic.
///
/// Pulled out of the controller so it can be stated once and pinned by tests.
/// It was correct before this existed, but only by reading it.
public enum ThreatIntelSource: Equatable, Sendable {
    /// Enrolled with a Hub: always try the Hub first.
    case hub
    /// No Hub, and the user turned direct downloads on.
    case directDownload
    /// No Hub and no opt-in. Nothing is fetched, and the screen must say that
    /// nobody looked rather than that nothing was found.
    case none

    /// - Parameters:
    ///   - isEnrolledWithHub: whether a credential is stored. **Not** whether
    ///     the Hub answered.
    ///   - isDirectDownloadEnabled: the standalone-mode opt-in. Hub fallback
    ///     has its own persisted permission and stale-cache gate.
    public static func decide(
        isEnrolledWithHub: Bool, isDirectDownloadEnabled: Bool
    ) -> ThreatIntelSource {
        if isEnrolledWithHub { return .hub }
        return isDirectDownloadEnabled ? .directDownload : .none
    }
}

/// Decides whether an explicitly approved Hub fallback may contact public
/// feed operators. A fresh cache wins over a network fallback: Hub downtime
/// must not create unnecessary third-party traffic.
public enum ThreatIntelFallbackPolicy {
    public static let cacheMaxAge: TimeInterval = 24 * 60 * 60

    public static func shouldDownload(
        isEnabled: Bool,
        hasCachedIndicators: Bool,
        lastSuccessfulFetch: Date?,
        now: Date = Date()
    ) -> Bool {
        guard isEnabled else { return false }
        guard hasCachedIndicators, let lastSuccessfulFetch else { return true }
        return now.timeIntervalSince(lastSuccessfulFetch) >= cacheMaxAge
    }
}
