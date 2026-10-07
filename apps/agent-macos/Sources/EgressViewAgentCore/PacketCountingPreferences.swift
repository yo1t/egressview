import Foundation

/// Whether the agent counts, from packet headers, the bytes of connections
/// macOS reports as zero (P3-183).
///
/// **Off unless the user turns it on.** macOS closes every connection made
/// through its own networking -- URLSession and Network.framework, and the QUIC
/// connections they make -- with a report of zero bytes each way, however much
/// they carried. A packet filter can count them from the IP and TCP/UDP headers,
/// but macOS hands the filter every packet one at a time, and on a test Mac
/// that took the extension from 3.7 to about 45 CPU-seconds an hour (P3-183,
/// 2026-10-07). A monitoring tool that costs more than it has to is not one
/// people keep, so the cost is the user's to choose.
///
/// The app reads this when it writes the filter configuration: on, the packet
/// filter is named in it and macOS starts it; off, it is not and macOS does not.
public struct PacketCountingPreferences {
    public static let enabledKey = "countsZeroReportFlowsFromPacketHeaders"

    private let defaults: UserDefaults

    public init() {
        defaults = UserDefaults(suiteName: ObservationJournal.appGroupIdentifier) ?? .standard
    }

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }
}
