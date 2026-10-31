import Foundation

/// What this Mac's outbound traffic usually looks like, as far as it has been
/// measured (P3-192, P3-193 phase 1).
///
/// Counted in monitored hours, never in calendar days: a Mac that sleeps most
/// of the week has a few hours of history, not seven days of silence, and
/// reading it as the second is how the fifteen-minute detector stayed in
/// "learning" for ever on a Windows PC (2026-10-31, 12 windows in 7 days).
/// The Windows Agent keeps the same tables by the same keys.
public struct OutboundBaselineSummary: Equatable, Sendable {
    public var monitoredHours: Double
    public var hoursRecorded: Int
    public var fullyMonitoredHours: Int
    public var since: Date?
    public var hourlyMedianBytesOut: UInt64
    public var hourlyP99BytesOut: UInt64
    public var largestHourBytesOut: UInt64
    /// Of the Internet observations, how many arrived with a destination name.
    public var namedShare: Double?
    /// Of the Internet observations, how many arrived with a byte count.
    public var bytesShare: Double?
    public var pairsKnown: Int

    public init(
        monitoredHours: Double = 0, hoursRecorded: Int = 0, fullyMonitoredHours: Int = 0,
        since: Date? = nil, hourlyMedianBytesOut: UInt64 = 0, hourlyP99BytesOut: UInt64 = 0,
        largestHourBytesOut: UInt64 = 0, namedShare: Double? = nil, bytesShare: Double? = nil,
        pairsKnown: Int = 0
    ) {
        self.monitoredHours = monitoredHours
        self.hoursRecorded = hoursRecorded
        self.fullyMonitoredHours = fullyMonitoredHours
        self.since = since
        self.hourlyMedianBytesOut = hourlyMedianBytesOut
        self.hourlyP99BytesOut = hourlyP99BytesOut
        self.largestHourBytesOut = largestHourBytesOut
        self.namedShare = namedShare
        self.bytesShare = bytesShare
        self.pairsKnown = pairsKnown
    }

    /// An hour with this much monitoring counts as fully monitored.
    public static let fullyMonitoredSeconds = 3420
}

/// The keys the baseline counts by, shared with the measurement scripts and
/// the Windows Agent so all three can be checked against each other.
public enum OutboundBaselineKeys {
    public static let unknownApplication = "(unknown)"

    /// The bundle ID when there is one, otherwise the process name -- the
    /// same identity `scripts/p3-193-measure-new-pairs.js` counts by.
    public static func application(bundleID: String?, processName: String?) -> String {
        for candidate in [bundleID, processName] {
            if let value = candidate?.trimmingCharacters(in: .whitespaces), !value.isEmpty {
                return value
            }
        }
        return unknownApplication
    }

    /// The registrable domain of a host name, approximately: the last two
    /// labels, or three under a two-letter top-level domain whose second level
    /// is three letters or fewer (co.jp, com.au). No public suffix list -- the
    /// same rule as the measurement scripts and the Windows Agent. Without a
    /// name, the address itself.
    public static func destination(hostname: String?, address: String) -> String {
        var host = (hostname ?? "").trimmingCharacters(in: .whitespaces).lowercased()
        while host.hasSuffix(".") { host.removeLast() }
        guard !host.isEmpty else { return address.lowercased() }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        guard labels.count > 2 else { return labels.joined(separator: ".") }
        let take = labels[labels.count - 1].count == 2 && labels[labels.count - 2].count <= 3 ? 3 : 2
        return labels.suffix(take).joined(separator: ".")
    }
}
