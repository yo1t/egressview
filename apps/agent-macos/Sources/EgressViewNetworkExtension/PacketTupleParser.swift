import Darwin
import EgressViewAgentCore
import Foundation

/// Protocol, addresses and ports from an IP packet's headers. Nothing else
/// from the packet is kept.
public struct PacketTuple: Hashable, Sendable {
    public let networkProtocol: InternetProtocol
    public let sourceAddress: String
    public let sourcePort: UInt16
    public let destinationAddress: String
    public let destinationPort: UInt16

    public init(
        networkProtocol: InternetProtocol,
        sourceAddress: String,
        sourcePort: UInt16,
        destinationAddress: String,
        destinationPort: UInt16
    ) {
        self.networkProtocol = networkProtocol
        self.sourceAddress = sourceAddress
        self.sourcePort = sourcePort
        self.destinationAddress = destinationAddress
        self.destinationPort = destinationPort
    }
}

/// What a packet's headers say: whose it is, and how much of it is payload.
public struct PacketHeader: Equatable, Sendable {
    public let tuple: PacketTuple
    /// The bytes after the IP and transport headers -- what a flow's own byte
    /// count measures, as opposed to the packet's length on the wire.
    public let payloadLength: Int
}

/// Reads only IP and transport headers. Unsupported headers fail closed rather
/// than assigning a packet to the wrong process.
public enum PacketTupleParser {
    public static func parse(_ packet: Data) -> PacketTuple? {
        parseHeaderPrefix(packet, packetLength: packet.count)
    }

    /// Parses a bounded header copy while validating lengths against the original packet.
    public static func parseHeaderPrefix(_ prefix: Data, packetLength: Int) -> PacketTuple? {
        prefix.withUnsafeBytes { header($0, packetLength: packetLength)?.tuple }
    }

    /// Parses the headers in place, without copying the packet. `bytes` may be
    /// a prefix of the packet; lengths are checked against `packetLength`.
    ///
    /// A packet filter hands over the frame as the interface carries it: on
    /// Ethernet and Wi-Fi that starts with a 14-byte link-layer header, which
    /// build 190 did not expect -- every one of 360,347 packets was unreadable.
    /// A frame whose EtherType names IPv4 or IPv6 is read from after that
    /// header (and a VLAN tag); anything else is tried as a bare IP packet,
    /// as a tunnel interface delivers it.
    public static func header(_ bytes: UnsafeRawBufferPointer, packetLength: Int) -> PacketHeader? {
        if let offset = linkLayerLength(bytes) {
            return ipHeader(
                UnsafeRawBufferPointer(rebasing: bytes[offset...]), packetLength: packetLength - offset
            )
        }
        return ipHeader(bytes, packetLength: packetLength)
    }

    /// Where the IP header starts in an Ethernet frame, or nil when this is
    /// not one carrying IPv4 or IPv6.
    static func linkLayerLength(_ bytes: UnsafeRawBufferPointer) -> Int? {
        var offset = 12
        guard bytes.count >= offset + 2 else { return nil }
        var etherType = word(bytes, at: offset)
        if etherType == 0x8100 || etherType == 0x88a8 {
            offset += 4
            guard bytes.count >= offset + 2 else { return nil }
            etherType = word(bytes, at: offset)
        }
        let ipStart = offset + 2
        guard bytes.count > ipStart else { return nil }
        let version = bytes[ipStart] >> 4
        switch etherType {
        case 0x0800 where version == 4: return ipStart
        case 0x86dd where version == 6: return ipStart
        default: return nil
        }
    }

    private static func ipHeader(_ bytes: UnsafeRawBufferPointer, packetLength: Int) -> PacketHeader? {
        guard !bytes.isEmpty else { return nil }
        switch bytes[0] >> 4 {
        case 4: return parseIPv4(bytes, packetLength: packetLength)
        case 6: return parseIPv6(bytes, packetLength: packetLength)
        default: return nil
        }
    }

    private static func parseIPv4(_ bytes: UnsafeRawBufferPointer, packetLength: Int) -> PacketHeader? {
        guard bytes.count >= 20 else { return nil }
        let headerLength = Int(bytes[0] & 0x0f) * 4
        let totalLength = Int(word(bytes, at: 2))
        let fragment = word(bytes, at: 6)
        guard headerLength >= 20, totalLength >= headerLength,
              totalLength <= packetLength, fragment & 0x3fff == 0 else { return nil }
        guard let networkProtocol = transport(bytes[9]),
              let transportLength = transportHeaderLength(
                  bytes, offset: headerLength, end: totalLength, protocol: networkProtocol
              ) else {
            return nil
        }
        return PacketHeader(
            tuple: PacketTuple(
                networkProtocol: networkProtocol,
                sourceAddress: "\(bytes[12]).\(bytes[13]).\(bytes[14]).\(bytes[15])",
                sourcePort: word(bytes, at: headerLength),
                destinationAddress: "\(bytes[16]).\(bytes[17]).\(bytes[18]).\(bytes[19])",
                destinationPort: word(bytes, at: headerLength + 2)
            ),
            payloadLength: totalLength - headerLength - transportLength
        )
    }

    private static func parseIPv6(_ bytes: UnsafeRawBufferPointer, packetLength: Int) -> PacketHeader? {
        guard bytes.count >= 40 else { return nil }
        let payloadLength = Int(word(bytes, at: 4))
        let end = 40 + payloadLength
        // Jumbo payloads and extension headers need separate handling. Do not
        // assume the transport header starts at byte 40 in those cases.
        guard payloadLength > 0, end <= packetLength,
              let networkProtocol = transport(bytes[6]),
              let transportLength = transportHeaderLength(bytes, offset: 40, end: end, protocol: networkProtocol),
              let source = ipv6Address(bytes, at: 8),
              let destination = ipv6Address(bytes, at: 24) else { return nil }
        return PacketHeader(
            tuple: PacketTuple(
                networkProtocol: networkProtocol,
                sourceAddress: source,
                sourcePort: word(bytes, at: 40),
                destinationAddress: destination,
                destinationPort: word(bytes, at: 42)
            ),
            payloadLength: payloadLength - transportLength
        )
    }

    /// The transport header's length, or nil when it is not a valid one.
    private static func transportHeaderLength(
        _ bytes: UnsafeRawBufferPointer, offset: Int, end: Int,
        protocol networkProtocol: EgressViewAgentCore.InternetProtocol
    ) -> Int? {
        let minimumLength = networkProtocol == .tcp ? 20 : 8
        guard end - offset >= minimumLength, bytes.count - offset >= minimumLength else { return nil }
        if networkProtocol == .tcp {
            let tcpHeaderLength = Int(bytes[offset + 12] >> 4) * 4
            guard tcpHeaderLength >= 20, end - offset >= tcpHeaderLength,
                  bytes.count - offset >= tcpHeaderLength else { return nil }
            return tcpHeaderLength
        }
        let udpLength = Int(word(bytes, at: offset + 4))
        guard udpLength >= 8, udpLength <= end - offset else { return nil }
        return 8
    }

    private static func transport(_ number: UInt8) -> EgressViewAgentCore.InternetProtocol? {
        switch number {
        case 6: return .tcp
        case 17: return .udp
        default: return nil
        }
    }

    private static func word(_ bytes: UnsafeRawBufferPointer, at offset: Int) -> UInt16 {
        UInt16(bytes[offset]) << 8 | UInt16(bytes[offset + 1])
    }

    private static func ipv6Address(_ bytes: UnsafeRawBufferPointer, at offset: Int) -> String? {
        guard let base = bytes.baseAddress else { return nil }
        var text = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
        let converted = inet_ntop(AF_INET6, base.advanced(by: offset), &text, socklen_t(text.count))
        guard converted != nil else { return nil }
        return String(cString: text)
    }
}
