import Foundation

public enum InternetProtocol: String, Codable, Sendable, CaseIterable, Hashable {
    case tcp
    case udp
}

public enum CollectorKind: String, Codable, Sendable, CaseIterable, Hashable {
    case networkExtension = "network-extension"
    case libproc
}

public enum ObservationConfidence: String, Codable, Sendable {
    case exact
    case sampled
}

public struct ConnectionObservation: Codable, Equatable, Sendable {
    public let networkProtocol: InternetProtocol
    public let localAddress: String
    public let localPort: UInt16
    public let remoteAddress: String
    public let remotePort: UInt16
    public let processID: Int32
    public let processName: String
    public let bundleID: String?
    public let firstObservedAt: Date
    public let lastObservedAt: Date
    public let bytesIn: UInt64?
    public let bytesOut: UInt64?
    public let collector: CollectorKind
    public let confidence: ObservationConfidence
    /// The name the application itself asked for, when the system knows it.
    ///
    /// Local only. It is deliberately absent from `AgentIngestObservation`:
    /// the shipped Hub's ingest schema is `.strict()` and would reject the
    /// whole batch. Sending it needs P3-7's agent-side negotiation first.
    public let remoteHostname: String?

    public init(
        networkProtocol: InternetProtocol,
        localAddress: String,
        localPort: UInt16,
        remoteAddress: String,
        remotePort: UInt16,
        processID: Int32,
        processName: String,
        bundleID: String? = nil,
        firstObservedAt: Date,
        lastObservedAt: Date,
        bytesIn: UInt64? = nil,
        bytesOut: UInt64? = nil,
        collector: CollectorKind,
        confidence: ObservationConfidence,
        remoteHostname: String? = nil
    ) {
        self.networkProtocol = networkProtocol
        self.localAddress = localAddress
        self.localPort = localPort
        self.remoteAddress = remoteAddress
        self.remotePort = remotePort
        self.processID = processID
        self.processName = processName
        self.bundleID = bundleID
        self.firstObservedAt = firstObservedAt
        self.lastObservedAt = lastObservedAt
        self.bytesIn = bytesIn
        self.bytesOut = bytesOut
        self.collector = collector
        self.confidence = confidence
        self.remoteHostname = remoteHostname
    }

    public var stableKey: String {
        [
            networkProtocol.rawValue,
            localAddress,
            String(localPort),
            remoteAddress,
            String(remotePort),
            String(processID),
        ].joined(separator: "|")
    }

    func merging(_ newer: ConnectionObservation) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: networkProtocol,
            localAddress: localAddress,
            localPort: localPort,
            remoteAddress: remoteAddress,
            remotePort: remotePort,
            processID: processID,
            processName: newer.processName,
            bundleID: newer.bundleID ?? bundleID,
            firstObservedAt: min(firstObservedAt, newer.firstObservedAt),
            lastObservedAt: max(lastObservedAt, newer.lastObservedAt),
            bytesIn: newer.bytesIn ?? bytesIn,
            bytesOut: newer.bytesOut ?? bytesOut,
            collector: newer.collector,
            confidence: newer.confidence,
            // A later flow that the system could not name must not erase a
            // name an earlier one carried.
            remoteHostname: newer.remoteHostname ?? remoteHostname
        )
    }
}
