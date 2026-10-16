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
/// headers", P3-183) sees those packets. A TCP reply carries ACK and is not
/// counted. A UDP reply carries nothing that says so: macOS picks the source
/// port of a DNS query anywhere from 1024 up, so the router's answers land on
/// low ports too. A UDP datagram is therefore a reply when this Mac sent one
/// to that sender and port from that local port shortly before, or sent one
/// from that local port to a multicast or broadcast address (SSDP, mDNS
/// discovery). Multicast and broadcast are discovery, not probing, and are
/// not counted either. Only addresses and port numbers are kept, never content.
public struct InboundProbeCounter: Sendable {
    public static let windowSeconds = 120
    /// A sender is reported from this many distinct ports. The Hub notifies
    /// from 10; sending from 5 keeps the near misses for whoever reads the
    /// stored rows later.
    public static let reportMinPorts = 5
    /// UDP to ports at or above this is not counted. It does not separate
    /// replies from probes (see above); it keeps the busiest traffic, most of
    /// which lands there, away from the lock in the packet handler.
    public static let ephemeralFloor: UInt16 = 49152
    /// How long a datagram this Mac sent makes the answers to it replies.
    public static let replySeconds = 120
    static let maxOutbound = 16384
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

    /// A datagram this Mac sent: the local port it left from, and where to.
    /// A nil remote stands for a multicast or broadcast destination, answered
    /// by whoever hears it.
    private struct Outbound: Hashable {
        let localPort: UInt16
        let remoteAddress: String?
        let remotePort: UInt16
    }

    private var tallies: [Key: Tally] = [:]
    private var lanSources: [String: Bool] = [:]
    /// Seconds since 1970 that each datagram was last sent.
    private var outbound: [Outbound: Int] = [:]

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

    /// Whether an outbound packet could be asked about by a reply that
    /// `counts` would otherwise take for a probe.
    public static func remembersOutbound(networkProtocol: InternetProtocol, sourcePort: UInt16) -> Bool {
        networkProtocol == .udp && sourcePort < ephemeralFloor
    }

    /// Remembers a datagram this Mac sent, so the answers to it are not
    /// counted as probes.
    public mutating func noteOutbound(
        networkProtocol: InternetProtocol, sourcePort: UInt16,
        destinationAddress: String, destinationPort: UInt16, at time: Date
    ) {
        guard Self.remembersOutbound(networkProtocol: networkProtocol, sourcePort: sourcePort) else { return }
        let key: Outbound
        if Self.isMulticastOrBroadcast(destinationAddress) {
            key = Outbound(localPort: sourcePort, remoteAddress: nil, remotePort: 0)
        } else if isLANSender(destinationAddress) {
            key = Outbound(localPort: sourcePort, remoteAddress: destinationAddress, remotePort: destinationPort)
        } else {
            return
        }
        let now = Int(time.timeIntervalSince1970)
        if outbound[key] == nil, outbound.count >= Self.maxOutbound {
            forgetOutbound(before: now - Self.replySeconds)
            if outbound.count >= Self.maxOutbound { return }
        }
        outbound[key] = now
    }

    public mutating func record(
        networkProtocol: InternetProtocol, sourceAddress: String, sourcePort: UInt16,
        destinationAddress: String, destinationPort: UInt16, tcpFlags: UInt8?, at time: Date
    ) {
        guard Self.counts(networkProtocol: networkProtocol, destinationPort: destinationPort, tcpFlags: tcpFlags),
              sourceAddress != destinationAddress,
              !Self.isMulticastOrBroadcast(destinationAddress),
              isLANSender(sourceAddress) else { return }
        if networkProtocol == .udp, isReply(from: sourceAddress, port: sourcePort, to: destinationPort, at: time) {
            return
        }
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
        forgetOutbound(before: Int(now.timeIntervalSince1970) - Self.replySeconds)
        return summaries.sorted { ($0.windowStart, $0.sourceAddress) < ($1.windowStart, $1.sourceAddress) }
    }

    private func isReply(from address: String, port: UInt16, to localPort: UInt16, at time: Date) -> Bool {
        let since = Int(time.timeIntervalSince1970) - Self.replySeconds
        for key in [Outbound(localPort: localPort, remoteAddress: address, remotePort: port),
                    Outbound(localPort: localPort, remoteAddress: nil, remotePort: 0)] {
            if let sent = outbound[key], sent >= since { return true }
        }
        return false
    }

    private mutating func forgetOutbound(before cutoff: Int) {
        outbound = outbound.filter { $0.value >= cutoff }
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
