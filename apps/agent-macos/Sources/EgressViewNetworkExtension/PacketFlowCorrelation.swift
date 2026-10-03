import EgressViewAgentCore
import Foundation

/// Metadata extracted from an IP packet header. Packet contents are not retained.
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

public struct CorrelatableFlow: Sendable {
    public let id: UUID
    public let metadata: SocketFlowMetadata

    public init(id: UUID, metadata: SocketFlowMetadata) {
        self.id = id
        self.metadata = metadata
    }
}

/// A code-only feasibility check; not connected to the packet provider or byte accounting.
public enum PacketFlowCorrelation {
    public enum Result: Equatable {
        case unique(UUID)
        case none
        case ambiguous
    }

    public static func match(
        _ packet: PacketTuple,
        inbound: Bool,
        among flows: [CorrelatableFlow]
    ) -> Result {
        var match: UUID?
        for flow in flows {
            let metadata = flow.metadata
            guard metadata.processID > 0, metadata.hasLocalEndpoint,
                  metadata.networkProtocol == packet.networkProtocol else { continue }

            let matches = inbound
                ? packet.sourceAddress == metadata.remoteAddress
                    && packet.sourcePort == metadata.remotePort
                    && packet.destinationAddress == metadata.localAddress
                    && packet.destinationPort == metadata.localPort
                : packet.sourceAddress == metadata.localAddress
                    && packet.sourcePort == metadata.localPort
                    && packet.destinationAddress == metadata.remoteAddress
                    && packet.destinationPort == metadata.remotePort
            if matches {
                if match != nil { return .ambiguous }
                match = flow.id
            }
        }
        return match.map(Result.unique) ?? .none
    }
}

/// Keeps matching O(1) per packet. A reused tuple is only accepted while it
/// belongs to exactly one live flow; the caller must remove flows on close.
public struct PacketFlowIndex {
    private var outbound: [PacketTuple: Set<UUID>] = [:]
    private var inbound: [PacketTuple: Set<UUID>] = [:]
    private var keysByFlow: [UUID: (outbound: PacketTuple, inbound: PacketTuple)] = [:]

    public init() {}

    public mutating func insert(_ flow: CorrelatableFlow) {
        remove(flowID: flow.id)
        let metadata = flow.metadata
        guard metadata.processID > 0, metadata.hasLocalEndpoint else { return }
        let outboundKey = PacketTuple(
            networkProtocol: metadata.networkProtocol,
            sourceAddress: metadata.localAddress, sourcePort: metadata.localPort,
            destinationAddress: metadata.remoteAddress, destinationPort: metadata.remotePort
        )
        let inboundKey = PacketTuple(
            networkProtocol: metadata.networkProtocol,
            sourceAddress: metadata.remoteAddress, sourcePort: metadata.remotePort,
            destinationAddress: metadata.localAddress, destinationPort: metadata.localPort
        )
        outbound[outboundKey, default: []].insert(flow.id)
        inbound[inboundKey, default: []].insert(flow.id)
        keysByFlow[flow.id] = (outboundKey, inboundKey)
    }

    public mutating func remove(flowID: UUID) {
        guard let keys = keysByFlow.removeValue(forKey: flowID) else { return }
        outbound[keys.outbound]?.remove(flowID)
        inbound[keys.inbound]?.remove(flowID)
        if outbound[keys.outbound]?.isEmpty == true { outbound.removeValue(forKey: keys.outbound) }
        if inbound[keys.inbound]?.isEmpty == true { inbound.removeValue(forKey: keys.inbound) }
    }

    public func match(_ packet: PacketTuple, inbound isInbound: Bool) -> PacketFlowCorrelation.Result {
        let candidates = isInbound ? inbound[packet] : outbound[packet]
        guard let candidates, !candidates.isEmpty else { return .none }
        guard candidates.count == 1, let id = candidates.first else { return .ambiguous }
        return .unique(id)
    }
}
