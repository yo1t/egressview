import Foundation

/// What a Hub says it can accept, and which schema version to send it.
///
/// Without this the agent sends `currentSchemaVersion` and finds out from a
/// 400 whether the Hub understood it (P3-7). That works while there is one
/// version; it stops working the moment a newer agent meets an older Hub,
/// because the refusal arrives per batch and says nothing the agent can act on
/// until someone reads a log.
public struct AgentHubCapabilities: Sendable, Equatable, Decodable {
    public let schemaVersions: [Int]
    public let maxObservationsPerBatch: Int?
    public let maxBodyBytes: Int?
    public let requestsPerMinute: Int?
    public let compression: [String]?

    public init(
        schemaVersions: [Int],
        maxObservationsPerBatch: Int? = nil,
        maxBodyBytes: Int? = nil,
        requestsPerMinute: Int? = nil,
        compression: [String]? = nil
    ) {
        self.schemaVersions = schemaVersions
        self.maxObservationsPerBatch = maxObservationsPerBatch
        self.maxBodyBytes = maxBodyBytes
        self.requestsPerMinute = requestsPerMinute
        self.compression = compression
    }
}

/// Chooses the schema version to send.
///
/// **A Hub that cannot be asked is not a Hub that refuses.** Capability
/// discovery failing -- a 404 from a Hub too old to have the endpoint, a 401
/// from one this agent is not enrolled with, no network at all -- means only
/// that the answer is unknown. Every such Hub still accepts version 1, so the
/// agent keeps sending and records the miss.
///
/// Deciding otherwise would mean stopping delivery on a configuration that
/// works, and telling the user about something they cannot act on. A warning
/// nobody can act on is what makes the ones that matter go unread
/// (2026-08-13 decision, carried here from the spec).
public enum AgentCapabilityNegotiation {
    /// Versions this agent can produce, newest first.
    public static let supportedByAgent: [Int] = [AgentIngestEnvelope.currentSchemaVersion]

    public enum Outcome: Sendable, Equatable {
        /// A version both sides speak. The highest one, so a Hub that has
        /// learned a newer format is used for it.
        case agreed(schemaVersion: Int)
        /// The Hub answered, and there is no version in common. This is the one
        /// case where retrying is pointless and the user has something to do.
        case incompatible(hubVersions: [Int], agentVersions: [Int])
        /// The Hub could not be asked. Send what has always worked.
        case unknown(fallbackSchemaVersion: Int)
    }

    /// - Parameter capabilities: nil when the capability request failed for any
    ///   reason. The reason is for the log, not for this decision.
    public static func decide(
        capabilities: AgentHubCapabilities?,
        agentVersions: [Int] = supportedByAgent
    ) -> Outcome {
        guard let capabilities else {
            return .unknown(fallbackSchemaVersion: agentVersions.min() ?? AgentIngestEnvelope.currentSchemaVersion)
        }
        let shared = Set(capabilities.schemaVersions).intersection(agentVersions)
        guard let best = shared.max() else {
            return .incompatible(
                hubVersions: capabilities.schemaVersions.sorted(),
                agentVersions: agentVersions.sorted()
            )
        }
        return .agreed(schemaVersion: best)
    }

    /// Whether the user should be told.
    ///
    /// Only when delivery has actually stopped. `unknown` never qualifies: the
    /// batches are still being accepted.
    public static func needsUserAttention(_ outcome: Outcome) -> Bool {
        if case .incompatible = outcome { return true }
        return false
    }

    /// How many observations may go in one batch, given what the Hub said.
    ///
    /// The agent's own limit still applies. A Hub is allowed to accept more
    /// than this agent is willing to send in one go; it is not allowed to make
    /// it send more.
    public static func batchSize(
        capabilities: AgentHubCapabilities?,
        agentLimit: Int
    ) -> Int {
        guard let hubLimit = capabilities?.maxObservationsPerBatch, hubLimit > 0 else {
            return agentLimit
        }
        return min(agentLimit, hubLimit)
    }
}
