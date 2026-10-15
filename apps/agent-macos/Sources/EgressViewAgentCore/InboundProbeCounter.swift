import Foundation

/// One LAN sender reaching many of this Mac's ports in one window, as the Hub
/// receives it (P3-191).
public struct InboundProbeSummary: Codable, Equatable, Sendable {
    public let windowStart: Date
    public let windowSeconds: Int
    /// This Mac's address the probes were sent to.
    public let localAddress: String
    public let sourceAddress: String
    public let networkProtocol: InternetProtocol
    public let distinctPorts: Int
    public let packets: Int
    /// Up to ten of the ports, lowest first.
    public let samplePorts: [UInt16]

    public init(
        windowStart: Date, windowSeconds: Int, localAddress: String, sourceAddress: String,
        networkProtocol: InternetProtocol, distinctPorts: Int, packets: Int, samplePorts: [UInt16]
    ) {
        self.windowStart = windowStart
        self.windowSeconds = windowSeconds
        self.localAddress = localAddress
        self.sourceAddress = sourceAddress
        self.networkProtocol = networkProtocol
        self.distinctPorts = distinctPorts
        self.packets = packets
        self.samplePorts = samplePorts
    }
}

/// Counts, from packet headers, how many of this Mac's ports each LAN sender
/// reaches in a window: TCP connection requests (SYN without ACK) and UDP
/// datagrams to ports below macOS's ephemeral range (P3-191).
///
/// The Network Extension sees sockets, so a probe of a port nothing listens on
/// never reaches it; only the packet filter (the optional "count from packet
/// headers", P3-183) sees those packets. Replies to this Mac's own traffic
/// arrive at its ephemeral ports (49152 and up) or carry ACK, and are not
/// counted. Multicast and broadcast are discovery, not probing, and are not
/// counted either. Only addresses and port numbers are kept, never content.
public struct InboundProbeCounter: Sendable {
    public static let windowSeconds = 120
    /// A sender is reported from this many distinct ports. The Hub notifies
    /// from 10; sending from 5 keeps the near misses for whoever reads the
    /// stored rows later.
    public static let reportMinPorts = 5
    /// macOS's ephemeral port range starts here: replies to this Mac's own
    /// connections arrive at ports at or above it.
    public static let ephemeralFloor: UInt16 = 49152
    static let maxSenders = 4096
    static let maxPortsPerSender = 4096
    static let sampleSize = 10

    private struct Key: Hashable {
        let windowStart: Int
        let localAddress: String
        let sourceAddress: String
        let networkProtocol: InternetProtocol
    }

    private struct Tally {
        var ports = Set<UInt16>()
        var packets = 0
    }

    private var tallies: [Key: Tally] = [:]
    private var lanSources: [String: Bool] = [:]

    public init() {}

    /// Whether this inbound packet is a probe worth counting, cheapest test
    /// first: most packets are replies and stop at the flag or port test.
    public static func counts(
        networkProtocol: InternetProtocol, destinationPort: UInt16, tcpFlags: UInt8?
    ) -> Bool {
        switch networkProtocol {
        case .tcp:
            guard let flags = tcpFlags else { return false }
            return flags & 0x02 != 0 && flags & 0x10 == 0   // SYN, not ACK
        case .udp:
            return destinationPort < ephemeralFloor
        }
    }

    public mutating func record(
        networkProtocol: InternetProtocol, sourceAddress: String,
        destinationAddress: String, destinationPort: UInt16, tcpFlags: UInt8?, at time: Date
    ) {
        guard Self.counts(networkProtocol: networkProtocol, destinationPort: destinationPort, tcpFlags: tcpFlags),
              sourceAddress != destinationAddress,
              !Self.isMulticastOrBroadcast(destinationAddress),
              isLANSender(sourceAddress) else { return }
        let window = Int(time.timeIntervalSince1970) / Self.windowSeconds * Self.windowSeconds
        let key = Key(windowStart: window, localAddress: destinationAddress,
                      sourceAddress: sourceAddress, networkProtocol: networkProtocol)
        if tallies[key] == nil, tallies.count >= Self.maxSenders { return }
        var tally = tallies[key] ?? Tally()
        if tally.ports.count < Self.maxPortsPerSender { tally.ports.insert(destinationPort) }
        tally.packets += 1
        tallies[key] = tally
    }

    /// The windows that have ended by `now`, reported and forgotten.
    public mutating func takeCompleted(now: Date) -> [InboundProbeSummary] {
        let current = Int(now.timeIntervalSince1970) / Self.windowSeconds * Self.windowSeconds
        var summaries: [InboundProbeSummary] = []
        for (key, tally) in tallies where key.windowStart < current {
            tallies[key] = nil
            guard tally.ports.count >= Self.reportMinPorts else { continue }
            summaries.append(InboundProbeSummary(
                windowStart: Date(timeIntervalSince1970: TimeInterval(key.windowStart)),
                windowSeconds: Self.windowSeconds,
                localAddress: key.localAddress,
                sourceAddress: key.sourceAddress,
                networkProtocol: key.networkProtocol,
                distinctPorts: tally.ports.count,
                packets: tally.packets,
                samplePorts: Array(tally.ports.sorted().prefix(Self.sampleSize))
            ))
        }
        if lanSources.count > Self.maxSenders { lanSources.removeAll() }
        return summaries.sorted { ($0.windowStart, $0.sourceAddress) < ($1.windowStart, $1.sourceAddress) }
    }

    private mutating func isLANSender(_ address: String) -> Bool {
        if let known = lanSources[address] { return known }
        let lan = NonPublicAddress.networkName(address) == NonPublicAddress.lan
        lanSources[address] = lan
        return lan
    }

    static func isMulticastOrBroadcast(_ address: String) -> Bool {
        if address.hasSuffix(".255") { return true }
        return NonPublicAddress.isWithin(
            address, ipv4: [("224.0.0.0", 4), ("240.0.0.0", 4)], ipv6: [("ff00::", 8)]
        )
    }
}
