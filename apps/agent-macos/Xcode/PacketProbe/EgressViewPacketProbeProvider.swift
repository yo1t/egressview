import EgressViewNetworkExtension
import Foundation
import NetworkExtension
import os

/// Development-only packet availability and cost probe. It never stores payloads or blocks packets.
final class EgressViewPacketProbeProvider: NEFilterPacketProvider {
    private let logger = Logger(subsystem: "com.egressview.agent.packetprobe", category: "P3-183")
    private let lock = NSLock()
    private var inboundPackets: UInt64 = 0
    private var inboundBytes: UInt64 = 0
    private var outboundPackets: UInt64 = 0
    private var outboundBytes: UInt64 = 0
    private var sampledPackets: UInt64 = 0
    private var parsedIPv4: UInt64 = 0
    private var parsedIPv6: UInt64 = 0
    private var lastLogTime = MonotonicSeconds.now()

    override func startFilter(completionHandler: @escaping (Error?) -> Void) {
        packetHandler = { [weak self] _, _, direction, packetBytes, length in
            self?.count(packetBytes, length: length, direction: direction)
            return .allow
        }
        logger.info("packet probe started")
        completionHandler(nil)
    }

    private func count(_ packetBytes: UnsafeRawPointer, length: Int, direction: NETrafficDirection) {
        lock.lock()
        if direction == .inbound {
            inboundPackets &+= 1
            inboundBytes &+= UInt64(length)
        } else if direction == .outbound {
            outboundPackets &+= 1
            outboundBytes &+= UInt64(length)
        }
        let totalPackets = inboundPackets &+ outboundPackets
        if totalPackets % 128 == 0 {
            sampledPackets &+= 1
            let packet = Data(bytes: packetBytes, count: min(length, 128))
            if PacketTupleParser.parseHeaderPrefix(packet, packetLength: length) != nil {
                if packet.first.map({ $0 >> 4 }) == 4 { parsedIPv4 &+= 1 }
                if packet.first.map({ $0 >> 4 }) == 6 { parsedIPv6 &+= 1 }
            }
        }
        if totalPackets % 1_024 == 0 {
            let now = MonotonicSeconds.now()
            if now - lastLogTime >= 10 {
                logger.info("packet interval inPackets=\(self.inboundPackets, privacy: .public) inBytes=\(self.inboundBytes, privacy: .public) outPackets=\(self.outboundPackets, privacy: .public) outBytes=\(self.outboundBytes, privacy: .public) sample=\(self.sampledPackets, privacy: .public) parsed4=\(self.parsedIPv4, privacy: .public) parsed6=\(self.parsedIPv6, privacy: .public)")
                inboundPackets = 0
                inboundBytes = 0
                outboundPackets = 0
                outboundBytes = 0
                sampledPackets = 0
                parsedIPv4 = 0
                parsedIPv6 = 0
                lastLogTime = now
            }
        }
        lock.unlock()
    }
}
