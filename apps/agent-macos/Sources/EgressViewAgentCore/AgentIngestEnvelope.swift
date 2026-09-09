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
    /// The name this Mac actually connected to, sent only when the Hub has
    /// said it accepts the field.
    ///
    /// `nil` is not encoded, so an agent talking to a Hub that never mentioned
    /// it sends exactly the payload it always did. That matters because the
    /// shipped ingest schema is `.strict()`: one unknown field rejects the
    /// whole batch, and every agent in the field would stop delivering
    /// (P3-14 stage 2).
    public let remoteHostname: String?

    /// - Parameter includeHostname: whether the Hub said it reads
    ///   `remoteHostname`. Defaults to false, so a caller that has not asked
    ///   cannot send it by forgetting to decide.
    public init(
        observationId: UUID,
        observation: ConnectionObservation,
        includeHostname: Bool = false
    ) {
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
        self.remoteHostname = includeHostname ? observation.remoteHostname : nil
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
        confidence: ObservationConfidence,
        remoteHostname: String? = nil
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
        self.remoteHostname = remoteHostname
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
        case remoteHostname
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
        // `encodeIfPresent`, not `encode`: a nil must leave the key out
        // entirely rather than send an explicit null. A Hub that does not know
        // the field would reject the batch either way, and the point of the
        // negotiation is that the payload is byte-for-byte what it always was
        // until the Hub says otherwise.
        try container.encodeIfPresent(remoteHostname, forKey: .remoteHostname)
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
