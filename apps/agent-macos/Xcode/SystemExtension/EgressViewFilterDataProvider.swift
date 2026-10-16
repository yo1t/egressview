import Foundation
import EgressViewAgentCore
import EgressViewNetworkExtension
import NetworkExtension

/// Shared by this extension's flow filter and packet filter, which run in one
/// process: the packet filter records, a closing flow settles (P3-183).
enum PacketCounting {
    static let ledger = PacketByteLedger()
    /// LAN senders reaching many of this Mac's ports (P3-191).
    static let probes = InboundProbeRecorder()
}

/// The packet filter's inbound probe counts, behind a lock: the packet handler
/// records on its queue and the XPC server takes completed windows on another.
final class InboundProbeRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var counter = InboundProbeCounter()

    func record(_ bytes: UnsafeRawBufferPointer, packetLength: Int) {
        guard let header = PacketTupleParser.header(bytes, packetLength: packetLength) else { return }
        let tuple = header.tuple
        // The cheap test first, outside the lock: most inbound packets are
        // replies and stop here.
        guard InboundProbeCounter.counts(
            networkProtocol: tuple.networkProtocol, destinationPort: tuple.destinationPort, tcpFlags: header.tcpFlags
        ) else { return }
        let now = Date()
        lock.withLock {
            counter.record(
                networkProtocol: tuple.networkProtocol, sourceAddress: tuple.sourceAddress,
                sourcePort: tuple.sourcePort,
                destinationAddress: tuple.destinationAddress, destinationPort: tuple.destinationPort,
                tcpFlags: header.tcpFlags, at: now
            )
        }
    }

    /// A datagram this Mac sends, so the answers to it are not counted.
    func noteOutbound(_ bytes: UnsafeRawBufferPointer, packetLength: Int) {
        guard let header = PacketTupleParser.header(bytes, packetLength: packetLength) else { return }
        let tuple = header.tuple
        guard InboundProbeCounter.remembersOutbound(
            networkProtocol: tuple.networkProtocol, sourcePort: tuple.sourcePort
        ) else { return }
        let now = Date()
        lock.withLock {
            counter.noteOutbound(
                networkProtocol: tuple.networkProtocol, sourcePort: tuple.sourcePort,
                destinationAddress: tuple.destinationAddress, destinationPort: tuple.destinationPort, at: now
            )
        }
    }

    func takeCompleted(now: Date = Date()) -> [InboundProbeSummary] {
        lock.withLock { counter.takeCompleted(now: now) }
    }

    func stats() -> InboundProbeCounter.Stats {
        lock.withLock { counter.stats }
    }
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
            let headerBytes = UnsafeRawBufferPointer(start: packetBytes, count: min(length, 128))
            PacketCounting.ledger.record(headerBytes, packetLength: length, outbound: direction == .outbound)
            if direction == .inbound {
                PacketCounting.probes.record(headerBytes, packetLength: length)
            } else {
                PacketCounting.probes.noteOutbound(headerBytes, packetLength: length)
            }
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
