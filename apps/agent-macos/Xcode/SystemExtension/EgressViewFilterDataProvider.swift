import EgressViewAgentCore
import EgressViewNetworkExtension
import NetworkExtension

/// Shared by this extension's flow filter and packet filter, which run in one
/// process: the packet filter records, a closing flow settles (P3-183).
enum PacketCounting {
    static let ledger = PacketByteLedger()
}

/// Counts packet headers for the flow filter in this same extension, so that
/// flows macOS closes with a zero report can still say how much they carried.
///
/// macOS starts it only while the user has turned the counting on: the app
/// names it in the filter configuration then and not otherwise. It reads
/// headers, keeps numbers, and lets every packet through.
final class EgressViewFilterPacketProvider: NEFilterPacketProvider {
    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        packetHandler = { _, _, direction, packetBytes, length in
            guard direction == .outbound || direction == .inbound else { return .allow }
            // The headers fit in the first 128 bytes: Ethernet with a VLAN tag
            // is 18, IPv6 40, TCP at most 60. The bytes are read in place.
            PacketCounting.ledger.record(
                UnsafeRawBufferPointer(start: packetBytes, count: min(length, 128)),
                packetLength: length,
                outbound: direction == .outbound
            )
            return .allow
        }
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
    override var readsServerName: Bool {
        FullMonitoringXPCServer.shared.isServerNameReadingEnabled
    }

    override func packetByteCounts(
        closing metadata: SocketFlowMetadata, reportedIn: UInt64, reportedOut: UInt64
    ) -> (inbound: UInt64, outbound: UInt64)? {
        // Taken on every close, used or not, so a later flow on the same
        // tuple never inherits these counts. With the counting off nothing is
        // recorded, and this finds nothing.
        guard let counts = PacketCounting.ledger.take(metadata) else { return nil }
        return (counts.inboundBytes, counts.outboundBytes)
    }

    override func didObserve(_ observation: ConnectionObservation) {
        FullMonitoringXPCServer.shared.enqueue(observation)
    }

    override func didRecordFlowCapture(_ stage: FlowCaptureDiagnostics.Stage) {
        FullMonitoringXPCServer.shared.recordFlowCapture(stage)
    }

    override func didObserveQUICFeasibility(_ event: QUICFeasibilityEvent) {
        FullMonitoringXPCServer.shared.record(event)
    }
}
