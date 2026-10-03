import EgressViewAgentCore
import EgressViewNetworkExtension
import Foundation
import NetworkExtension
#if P3_183_BYTE_PROBE || P3_183_PACKET_PROBE
import os
#endif

#if P3_183_PACKET_PROBE
/// Shared by this extension's flow filter and packet filter, which run in one
/// process: the packet filter records, a closing flow settles (P3-183).
enum PacketCounting {
    static let ledger = PacketByteLedger()
    static let logger = Logger(subsystem: "com.egressview.agent.filter", category: "P3-183Packets")
}
#endif

/// Counts packet headers for the flow filter in this same extension, so that
/// flows macOS closes with a zero report can still say how much they carried.
/// Development builds only; in any other build it lets every packet through
/// and is never configured. It reads headers and never holds a packet.
final class EgressViewFilterPacketProvider: NEFilterPacketProvider {
#if P3_183_PACKET_PROBE
    private var statsTimer: DispatchSourceTimer?
#endif

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
#if P3_183_PACKET_PROBE
        packetHandler = { _, _, direction, packetBytes, length in
            guard direction == .outbound || direction == .inbound else { return .allow }
            // The headers fit in the first 128 bytes: Ethernet with a VLAN tag
            // is 18, IPv6 40, TCP at most 60.
            PacketCounting.ledger.record(
                UnsafeRawBufferPointer(start: packetBytes, count: min(length, 128)),
                packetLength: length,
                outbound: direction == .outbound
            )
            return .allow
        }
        let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
        timer.schedule(deadline: .now() + 60, repeating: 60)
        timer.setEventHandler {
            let stats = PacketCounting.ledger.snapshot()
            PacketCounting.logger.info("packet ledger packets=\(stats.packets, privacy: .public) framed=\(stats.linkLayerFramed, privacy: .public) unreadable=\(stats.unreadable, privacy: .public) claimed=\(stats.claimed, privacy: .public) claimedEmpty=\(stats.claimedEmpty, privacy: .public) evicted=\(stats.evicted, privacy: .public) entries=\(stats.entries, privacy: .public) shapes=\(stats.unreadableShapes.joined(separator: ";"), privacy: .public)")
        }
        timer.resume()
        statsTimer = timer
        PacketCounting.logger.info("packet counting started")
#else
        packetHandler = { _, _, _, _, _ in .allow }
#endif
        completionHandler(nil)
    }

    override func stopFilter(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
#if P3_183_PACKET_PROBE
        statsTimer?.cancel()
        statsTimer = nil
#endif
        completionHandler()
    }
}

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
#if P3_183_BYTE_PROBE
    private struct ProbeState {
        let networkProtocol: InternetProtocol
        var inbound = FlowByteProbe()
        var outbound = FlowByteProbe()
        var openingHandled = false
        var truncated = false
    }

    private let probeLock = NSLock()
    private var probeFlows: [UUID: ProbeState] = [:]
    private var udpStatisticsFlows: Set<UUID> = []
    private let probeLogger = Logger(subsystem: "com.egressview.agent.filter", category: "P3-183ByteProbe")
    private let probeProcessNames: Set<String> = ["nscurl", "nwtest", "urlsestest"]
    private let probeLimit: UInt64 = 100_000_000
    private let probePeekBytes = 4_096

    override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        let normalVerdict = super.handleNewFlow(flow)
        guard let socketFlow = flow as? NEFilterSocketFlow,
              case let .success(metadata) = NetworkExtensionFlowAdapter().metadataResult(from: socketFlow),
              (metadata.networkProtocol == .tcp || metadata.networkProtocol == .udp),
              probeProcessNames.contains(metadata.processName)
        else { return normalVerdict }

        if metadata.networkProtocol == .udp {
            probeLock.lock()
            udpStatisticsFlows.insert(socketFlow.identifier)
            probeLock.unlock()
            normalVerdict.shouldReport = true
            normalVerdict.statisticsReportFrequency = .high
            return normalVerdict
        }

        probeLock.lock()
        probeFlows[socketFlow.identifier] = ProbeState(networkProtocol: metadata.networkProtocol)
        probeLock.unlock()
        let verdict = NEFilterNewFlowVerdict.filterDataVerdict(
            withFilterInbound: true,
            peekInboundBytes: probePeekBytes,
            filterOutbound: true,
            peekOutboundBytes: probePeekBytes
        )
        verdict.shouldReport = true
        return verdict
    }

    override func handleOutboundData(
        from flow: NEFilterFlow,
        readBytesStartOffset offset: Int,
        readBytes: Data
    ) -> NEFilterDataVerdict {
        probeLock.lock()
        let probeProtocol = probeFlows[flow.identifier]?.networkProtocol
        let isProbe = probeProtocol != nil
        let firstProbeCallback = isProbe && !(probeFlows[flow.identifier]?.openingHandled ?? true)
        if firstProbeCallback { probeFlows[flow.identifier]?.openingHandled = true }
        probeLock.unlock()

        if probeProtocol == .tcp && !firstProbeCallback {
            return probeVerdict(flow: flow, inbound: false, offset: offset, length: readBytes.count) ?? .allow()
        }
        let normalVerdict = super.handleOutboundData(from: flow, readBytesStartOffset: offset, readBytes: readBytes)
        return probeVerdict(flow: flow, inbound: false, offset: offset, length: readBytes.count) ?? normalVerdict
    }

    override func handleInboundData(
        from flow: NEFilterFlow,
        readBytesStartOffset offset: Int,
        readBytes: Data
    ) -> NEFilterDataVerdict {
        probeVerdict(flow: flow, inbound: true, offset: offset, length: readBytes.count) ?? .allow()
    }

    private func probeVerdict(flow: NEFilterFlow, inbound: Bool, offset: Int, length: Int) -> NEFilterDataVerdict? {
        probeLock.lock()
        defer { probeLock.unlock() }
        guard var state = probeFlows[flow.identifier] else { return nil }
        if inbound {
            state.inbound.observe(offset: offset, length: length)
        } else {
            state.outbound.observe(offset: offset, length: length)
        }
        let (total, overflow) = state.inbound.furthestObservedEnd.addingReportingOverflow(state.outbound.furthestObservedEnd)
        if overflow || total >= probeLimit {
            state.truncated = true
        }
        probeFlows[flow.identifier] = state
        return state.truncated ? .allow() : NEFilterDataVerdict(passBytes: length, peekBytes: probePeekBytes)
    }

    override func measuredByteCounts(for flowID: UUID) -> (inbound: UInt64, outbound: UInt64)? {
        probeLock.lock()
        defer { probeLock.unlock() }
        guard let state = probeFlows[flowID], state.networkProtocol == .tcp else { return nil }
        return FlowByteProbe.completeCounts(
            inbound: state.inbound,
            outbound: state.outbound,
            truncated: state.truncated
        )
    }

    override func handle(_ report: NEFilterReport) {
        super.handle(report)
        var state: ProbeState?
        var isUDPStatisticsFlow = false
        if let flow = report.flow {
            probeLock.lock()
            isUDPStatisticsFlow = udpStatisticsFlows.contains(flow.identifier)
            if report.event == .flowClosed {
                state = probeFlows.removeValue(forKey: flow.identifier)
                udpStatisticsFlows.remove(flow.identifier)
            }
            probeLock.unlock()
        }
        if isUDPStatisticsFlow && report.event == .statistics {
            probeLogger.info("udp statistics reportIn=\(report.bytesInboundCount, privacy: .public) reportOut=\(report.bytesOutboundCount, privacy: .public)")
        }
        if isUDPStatisticsFlow && report.event == .flowClosed {
            probeLogger.info("udp close reportIn=\(report.bytesInboundCount, privacy: .public) reportOut=\(report.bytesOutboundCount, privacy: .public)")
        }
        if let state {
            // Numbers only. Neither payload nor endpoint identity is logged.
            probeLogger.info("probe close protocol=\(state.networkProtocol.rawValue, privacy: .public) inboundCallbacks=\(state.inbound.callbackCount, privacy: .public) outboundCallbacks=\(state.outbound.callbackCount, privacy: .public) inboundPresented=\(state.inbound.presentedBytes, privacy: .public) outboundPresented=\(state.outbound.presentedBytes, privacy: .public) inboundZeroOffset=\(state.inbound.zeroOffsetCallbacks, privacy: .public) outboundZeroOffset=\(state.outbound.zeroOffsetCallbacks, privacy: .public) inboundEnd=\(state.inbound.furthestObservedEnd, privacy: .public) outboundEnd=\(state.outbound.furthestObservedEnd, privacy: .public) inboundGap=\(state.inbound.hasGap, privacy: .public) outboundGap=\(state.outbound.hasGap, privacy: .public) truncated=\(state.truncated, privacy: .public) reportIn=\(report.bytesInboundCount, privacy: .public) reportOut=\(report.bytesOutboundCount, privacy: .public)")
        }
    }
#endif

#if P3_183_PACKET_PROBE
    override func packetByteCounts(
        closing metadata: SocketFlowMetadata, reportedIn: UInt64, reportedOut: UInt64
    ) -> (inbound: UInt64, outbound: UInt64)? {
        guard let counts = PacketCounting.ledger.take(metadata) else { return nil }
        // Numbers only. With a non-zero report this is the check on the
        // counting itself: the same flow, counted by macOS and from packets.
        PacketCounting.logger.info("packet close protocol=\(metadata.networkProtocol.rawValue, privacy: .public) reportIn=\(reportedIn, privacy: .public) reportOut=\(reportedOut, privacy: .public) packetIn=\(counts.inboundBytes, privacy: .public) packetOut=\(counts.outboundBytes, privacy: .public) packetsIn=\(counts.inboundPackets, privacy: .public) packetsOut=\(counts.outboundPackets, privacy: .public)")
        return (counts.inboundBytes, counts.outboundBytes)
    }
#endif

    override var readsServerName: Bool {
        FullMonitoringXPCServer.shared.isServerNameReadingEnabled
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
