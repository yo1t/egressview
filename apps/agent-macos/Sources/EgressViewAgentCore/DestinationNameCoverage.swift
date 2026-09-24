import Foundation
import Network

/// How many of the destinations on screen this Mac could put a name to.
///
/// A user selected "destinations: by name", turned on reading names from the
/// system's own DNS metadata, and still saw a column of IP addresses. The
/// screen gave them no way to tell whether the setting was working, so the
/// reasonable guess was that it was not -- or that it needed the Hub, which it
/// does not: names are found here, on this Mac (P3-162).
///
/// Names are genuinely unavailable for some traffic, and no setting changes
/// that: a browser resolving over DoH, a connection made to a literal address,
/// traffic that was already open before monitoring started, and flows a name
/// cannot be correlated to in time. Falling back to the address is right. What
/// was missing is the number that says how often it happens, so that "mostly
/// addresses" reads as a property of the traffic rather than as a broken
/// setting.
///
/// **A low share is not a fault.** Nothing here treats it as one.
public struct DestinationNameCoverage: Equatable, Sendable {
    /// Unique destination addresses with at least one usable name.
    public let named: Int
    /// Unique destination addresses in the period.
    public let total: Int
    /// Connections whose own record carries a usable name.
    ///
    /// The same question counted over connections instead of addresses, and
    /// the two answers can be nothing alike: 93% against 11% on the Windows
    /// machine this card was first built for. Destinations that resolve are
    /// the majority; the ones that do not -- LAN hosts, broadcast, multicast
    /// -- carry most of the connections. The chart under the card is sorted
    /// by connections, so a reader shown only the first number sees a high
    /// share above a picture of addresses and is handed a new contradiction.
    public let namedConnections: Int
    /// Connections in the period, from the same rows as `total`.
    public let connections: Int

    public init(named: Int, total: Int, namedConnections: Int = 0, connections: Int = 0) {
        self.named = named
        self.total = total
        self.namedConnections = namedConnections
        self.connections = connections
    }

    /// Nil when the period holds no destinations at all -- which is not zero
    /// percent. Zero percent is an answer; this is the absence of one, and a
    /// screen that shows "0%" for an empty period reports a problem that does
    /// not exist.
    public var share: Double? {
        total > 0 ? Double(named) / Double(total) : nil
    }

    /// The share counted over connections. Nil for the same reason as `share`.
    public var connectionShare: Double? {
        connections > 0 ? Double(namedConnections) / Double(connections) : nil
    }

    public static let empty = DestinationNameCoverage(named: 0, total: 0)
}

public enum DestinationName {
    /// Whether a recorded hostname is a name, rather than a restatement of the
    /// address or a blank.
    ///
    /// The address itself is stored as the hostname in some paths, so a plain
    /// "is it empty" test counts those as named and the share reads as 100%
    /// on a machine that resolved nothing.
    public static func isUsable(_ hostname: String?, for address: String) -> Bool {
        guard let hostname else { return false }
        let trimmed = hostname.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        guard trimmed.caseInsensitiveCompare(address) != .orderedSame else { return false }
        // A literal address is not a name even when it is a different one from
        // the flow's own -- it tells the reader nothing the address column was
        // not already saying.
        return IPv4Address(trimmed) == nil && IPv6Address(trimmed) == nil
    }
}
