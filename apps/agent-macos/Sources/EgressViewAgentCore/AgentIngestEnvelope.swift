import Foundation

public enum AgentPlatform: String, Codable, Sendable {
    case macOS = "macos"
    case windows
    case linux
}

public struct AgentIngestMetadata: Codable, Equatable, Sendable {
    public let hostName: String
    public let platform: AgentPlatform
    public let osVersion: String
    public let agentVersion: String

    public init(hostName: String, platform: AgentPlatform, osVersion: String, agentVersion: String) {
        self.hostName = hostName
        self.platform = platform
        self.osVersion = osVersion
        self.agentVersion = agentVersion
    }
}

public struct AgentIngestObservation: Codable, Equatable, Sendable {
    public let observationId: UUID
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
    public let bytesIn: String?
    public let bytesOut: String?
    public let collector: CollectorKind
    public let confidence: ObservationConfidence

    public init(observationId: UUID, observation: ConnectionObservation) {
        self.observationId = observationId
        self.networkProtocol = observation.networkProtocol
        self.localAddress = observation.localAddress
        self.localPort = observation.localPort
        self.remoteAddress = observation.remoteAddress
        self.remotePort = observation.remotePort
        self.processID = observation.processID
        self.processName = observation.processName
        self.bundleID = observation.bundleID
        self.firstObservedAt = observation.firstObservedAt
        self.lastObservedAt = observation.lastObservedAt
        // Decimal strings preserve the full UInt64 range across JSON/JavaScript.
        self.bytesIn = observation.bytesIn.map(String.init)
        self.bytesOut = observation.bytesOut.map(String.init)
        self.collector = observation.collector
        self.confidence = observation.confidence
    }

    public init(
        observationId: UUID,
        networkProtocol: InternetProtocol,
        localAddress: String,
        localPort: UInt16,
        remoteAddress: String,
        remotePort: UInt16,
        processID: Int32,
        processName: String,
        bundleID: String?,
        firstObservedAt: Date,
        lastObservedAt: Date,
        bytesIn: String?,
        bytesOut: String?,
        collector: CollectorKind,
        confidence: ObservationConfidence
    ) {
        self.observationId = observationId
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
    }

    private enum CodingKeys: String, CodingKey {
        case observationId
        case networkProtocol
        case localAddress
        case localPort
        case remoteAddress
        case remotePort
        case processID
        case processName
        case bundleID
        case firstObservedAt
        case lastObservedAt
        case bytesIn
        case bytesOut
        case collector
        case confidence
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(observationId, forKey: .observationId)
        try container.encode(networkProtocol, forKey: .networkProtocol)
        try container.encode(localAddress, forKey: .localAddress)
        try container.encode(localPort, forKey: .localPort)
        try container.encode(remoteAddress, forKey: .remoteAddress)
        try container.encode(remotePort, forKey: .remotePort)
        try container.encode(processID, forKey: .processID)
        try container.encode(processName, forKey: .processName)
        try container.encode(bundleID, forKey: .bundleID)
        try container.encode(firstObservedAt, forKey: .firstObservedAt)
        try container.encode(lastObservedAt, forKey: .lastObservedAt)
        try container.encode(bytesIn, forKey: .bytesIn)
        try container.encode(bytesOut, forKey: .bytesOut)
        try container.encode(collector, forKey: .collector)
        try container.encode(confidence, forKey: .confidence)
    }
}

public struct AgentIngestEnvelope: Codable, Equatable, Sendable {
    public static let currentSchemaVersion = 1

    public let schemaVersion: Int
    public let batchId: UUID
    public let sentAt: Date
    public let agent: AgentIngestMetadata
    public let observations: [AgentIngestObservation]

    public init(
        schemaVersion: Int = currentSchemaVersion,
        batchId: UUID,
        sentAt: Date,
        agent: AgentIngestMetadata,
        observations: [AgentIngestObservation]
    ) {
        self.schemaVersion = schemaVersion
        self.batchId = batchId
        self.sentAt = sentAt
        self.agent = agent
        self.observations = observations
    }
}
