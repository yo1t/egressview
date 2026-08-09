import CLibProcBridge
import EgressViewAgentCore
import Foundation
import NetworkExtension

public struct SocketFlowMetadata: Equatable, Sendable {
    public let networkProtocol: InternetProtocol
    public let localAddress: String
    public let localPort: UInt16
    public let remoteAddress: String
    public let remotePort: UInt16
    public let processID: Int32
    public let processName: String
    public let bundleID: String?

    public init(
        networkProtocol: InternetProtocol,
        localAddress: String,
        localPort: UInt16,
        remoteAddress: String,
        remotePort: UInt16,
        processID: Int32,
        processName: String,
        bundleID: String? = nil
    ) {
        self.networkProtocol = networkProtocol
        self.localAddress = localAddress
        self.localPort = localPort
        self.remoteAddress = remoteAddress
        self.remotePort = remotePort
        self.processID = processID
        self.processName = processName
        self.bundleID = bundleID
    }
}

public struct NetworkFlowObservationMapper: Sendable {
    public init() {}

    public func map(_ metadata: SocketFlowMetadata, observedAt: Date = Date()) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: metadata.networkProtocol,
            localAddress: metadata.localAddress,
            localPort: metadata.localPort,
            remoteAddress: metadata.remoteAddress,
            remotePort: metadata.remotePort,
            processID: metadata.processID,
            processName: metadata.processName,
            bundleID: metadata.bundleID,
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            bytesIn: nil,
            bytesOut: nil,
            collector: .networkExtension,
            confidence: .exact
        )
    }
}

public struct NetworkExtensionFlowAdapter {
    public init() {}

    public func metadata(from flow: NEFilterSocketFlow) -> SocketFlowMetadata? {
        guard flow.direction == .outbound,
              let networkProtocol = InternetProtocol(socketProtocol: flow.socketProtocol),
              let local = endpointParts(flow.localEndpoint),
              let remote = endpointParts(flow.remoteEndpoint)
        else {
            return nil
        }

        let processID = processID(from: flow.sourceProcessAuditToken ?? flow.sourceAppAuditToken)
        return SocketFlowMetadata(
            networkProtocol: networkProtocol,
            localAddress: local.address,
            localPort: local.port,
            remoteAddress: remote.address,
            remotePort: remote.port,
            processID: processID,
            processName: processName(for: processID)
        )
    }

    private func endpointParts(_ endpoint: NWEndpoint?) -> (address: String, port: UInt16)? {
        guard let host = endpoint as? NWHostEndpoint,
              let port = UInt16(host.port)
        else {
            return nil
        }
        return (host.hostname, port)
    }

    private func processID(from data: Data?) -> Int32 {
        guard let data else { return 0 }
        return data.withUnsafeBytes { buffer in
            egv_audit_token_pid(buffer.bindMemory(to: UInt8.self).baseAddress, buffer.count)
        }
    }

    private func processName(for processID: Int32) -> String {
        guard processID > 0 else { return "unknown" }
        var output = [CChar](repeating: 0, count: Int(EGV_PROCESS_NAME_LENGTH))
        let length = egv_process_name(processID, &output, Int32(output.count))
        return length > 0 ? String(cString: output) : "pid-\(processID)"
    }
}

private extension InternetProtocol {
    init?(socketProtocol: Int32) {
        switch socketProtocol {
        case IPPROTO_TCP:
            self = .tcp
        case IPPROTO_UDP:
            self = .udp
        default:
            return nil
        }
    }
}
