import EgressViewAgentCore
import Foundation

/// Byte counts per connection, kept from packet headers (P3-183).
///
/// macOS closes many flows with a report of zero bytes each way: every
/// Network.framework and URLSession connection, QUIC included. The flow
/// filter cannot fill those in -- passing every byte through it to count
/// stalled a 74 MB QUIC download for 30 s -- and the system offers no other
/// per-flow counter. A packet filter sees every packet's headers at almost no
/// cost (the same download: 0.58-0.74 s with it, 0.56-0.61 s without), but it
/// is not told which flow a packet belongs to.
///
/// So this keeps counts by five-tuple, oriented from this Mac outwards, and a
/// closing flow claims the entry for its own tuple. Keying on the tuple rather
/// than on registered flows matters because a flow's local port is usually
/// not known when the flow opens (94% of TCP flows on 2026-09-27), while by
/// the time it closes it is.
///
/// Every close takes its tuple's entry, whether or not the count is used, so a
/// later flow that reuses the tuple never inherits an earlier one's bytes.
/// Packets whose headers cannot be read are counted and never guessed at.
/// Nothing from a packet beyond its headers is read, and nothing is kept but
/// the tuple and the numbers.
public final class PacketByteLedger: @unchecked Sendable {
    public struct Counts: Equatable, Sendable {
        /// Payload bytes: the packet less its IP and transport headers.
        public var inboundBytes: UInt64 = 0
        public var outboundBytes: UInt64 = 0
        public var inboundPackets: UInt64 = 0
        public var outboundPackets: UInt64 = 0

        public init(
            inboundBytes: UInt64 = 0, outboundBytes: UInt64 = 0,
            inboundPackets: UInt64 = 0, outboundPackets: UInt64 = 0
        ) {
            self.inboundBytes = inboundBytes
            self.outboundBytes = outboundBytes
            self.inboundPackets = inboundPackets
            self.outboundPackets = outboundPackets
        }
    }

    public struct Stats: Equatable, Sendable {
        public var packets: UInt64 = 0
        /// Packets that arrived with an Ethernet header in front of the IP one.
        public var linkLayerFramed: UInt64 = 0
        public var unreadable: UInt64 = 0
        public var claimed: UInt64 = 0
        public var claimedEmpty: UInt64 = 0
        public var evicted: UInt64 = 0
        public var entries: Int = 0
        /// The shape of the first few unreadable packets: length, first byte,
        /// the two bytes where an EtherType would be, and the byte after them.
        /// No address, no payload -- enough to see what framing arrived.
        public var unreadableShapes: [String] = []
    }

    private struct Entry {
        var counts = Counts()
        var lastSeen: TimeInterval
    }

    public static let defaultCapacity = 65_536
    public static let defaultIdleSeconds: TimeInterval = 600

    private let capacity: Int
    private let idleSeconds: TimeInterval
    private let now: () -> TimeInterval
    private let lock = NSLock()
    private var entries: [PacketTuple: Entry] = [:]
    private var stats = Stats()
    private var insertsSinceSweep = 0

    public init(
        capacity: Int = PacketByteLedger.defaultCapacity,
        idleSeconds: TimeInterval = PacketByteLedger.defaultIdleSeconds,
        now: @escaping () -> TimeInterval = { MonotonicSeconds.now() }
    ) {
        self.capacity = capacity
        self.idleSeconds = idleSeconds
        self.now = now
    }

    /// Counts one packet from its headers. `bytes` may be a prefix of it.
    public func record(_ bytes: UnsafeRawBufferPointer, packetLength: Int, outbound: Bool) {
        let framed = PacketTupleParser.linkLayerLength(bytes) != nil
        if framed { lock.withLock { stats.linkLayerFramed &+= 1 } }
        guard let header = PacketTupleParser.header(bytes, packetLength: packetLength) else {
            lock.withLock {
                stats.packets &+= 1
                stats.unreadable &+= 1
                if stats.unreadableShapes.count < 4 { stats.unreadableShapes.append(Self.shape(bytes, packetLength)) }
            }
            return
        }
        record(header, outbound: outbound)
    }

    public func record(_ header: PacketHeader, outbound: Bool) {
        let key = outbound ? Self.normalized(header.tuple) : Self.normalized(Self.reversed(header.tuple))
        let at = now()
        lock.withLock {
            stats.packets &+= 1
            var entry = entries[key] ?? {
                insertsSinceSweep += 1
                return Entry(lastSeen: at)
            }()
            let payload = UInt64(max(0, header.payloadLength))
            if outbound {
                entry.counts.outboundBytes &+= payload
                entry.counts.outboundPackets &+= 1
            } else {
                entry.counts.inboundBytes &+= payload
                entry.counts.inboundPackets &+= 1
            }
            entry.lastSeen = at
            entries[key] = entry
            if entries.count > capacity || insertsSinceSweep >= 4_096 { sweep(at: at) }
        }
    }

    /// Takes the counts kept for a closing flow's tuple, removing them either
    /// way. Nil when no packet of the flow was seen, or the flow does not know
    /// its local endpoint.
    public func take(_ metadata: SocketFlowMetadata) -> Counts? {
        guard metadata.hasLocalEndpoint else { return nil }
        let key = Self.normalized(PacketTuple(
            networkProtocol: metadata.networkProtocol,
            sourceAddress: metadata.localAddress, sourcePort: metadata.localPort,
            destinationAddress: metadata.remoteAddress, destinationPort: metadata.remotePort
        ))
        return lock.withLock {
            guard let entry = entries.removeValue(forKey: key) else {
                stats.claimedEmpty &+= 1
                return nil
            }
            stats.claimed &+= 1
            return entry.counts
        }
    }

    public func snapshot() -> Stats {
        lock.withLock {
            var copy = stats
            copy.entries = entries.count
            return copy
        }
    }

    /// Drops entries no packet has touched for `idleSeconds`, then, if still
    /// over capacity, the least recently seen. Called with the lock held.
    private func sweep(at time: TimeInterval) {
        insertsSinceSweep = 0
        let before = entries.count
        entries = entries.filter { time - $0.value.lastSeen < idleSeconds }
        if entries.count > capacity {
            let excess = entries.count - capacity
            for key in entries.sorted(by: { $0.value.lastSeen < $1.value.lastSeen }).prefix(excess).map(\.key) {
                entries.removeValue(forKey: key)
            }
        }
        stats.evicted &+= UInt64(before - entries.count)
    }

    static func shape(_ bytes: UnsafeRawBufferPointer, _ packetLength: Int) -> String {
        func hex(_ index: Int) -> String { index < bytes.count ? String(format: "%02x", bytes[index]) : "--" }
        return "len=\(packetLength) b0=\(hex(0)) et=\(hex(12))\(hex(13)) b14=\(hex(14))"
    }

    static func reversed(_ tuple: PacketTuple) -> PacketTuple {
        PacketTuple(
            networkProtocol: tuple.networkProtocol,
            sourceAddress: tuple.destinationAddress, sourcePort: tuple.destinationPort,
            destinationAddress: tuple.sourceAddress, destinationPort: tuple.sourcePort
        )
    }

    static func normalized(_ tuple: PacketTuple) -> PacketTuple {
        PacketTuple(
            networkProtocol: tuple.networkProtocol,
            sourceAddress: normalizedAddress(tuple.sourceAddress), sourcePort: tuple.sourcePort,
            destinationAddress: normalizedAddress(tuple.destinationAddress), destinationPort: tuple.destinationPort
        )
    }

    /// The same address the way a packet header and a socket endpoint both
    /// write it: an IPv4-mapped IPv6 address as plain IPv4, without a zone,
    /// in lower case.
    static func normalizedAddress(_ address: String) -> String {
        var value = address.lowercased()
        if let percent = value.firstIndex(of: "%") { value = String(value[..<percent]) }
        if value.hasPrefix("::ffff:"), value.dropFirst(7).contains(".") { value = String(value.dropFirst(7)) }
        return value
    }
}
