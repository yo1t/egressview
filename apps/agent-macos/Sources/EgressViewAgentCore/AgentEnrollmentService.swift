import Foundation

public struct AgentEnrollmentMetadata: Codable, Equatable, Sendable {
    public let hostName: String
    public let platform: String
    public let osVersion: String
    public let agentVersion: String

    public init(hostName: String, platform: String, osVersion: String, agentVersion: String) {
        self.hostName = hostName
        self.platform = platform
        self.osVersion = osVersion
        self.agentVersion = agentVersion
    }
}

public protocol AgentEnrollmentTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionAgentEnrollmentTransport: AgentEnrollmentTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 15) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw AgentEnrollmentError.invalidResponse
        }
        return (data, httpResponse)
    }
}

public enum AgentEnrollmentError: Error, Equatable {
    case invalidHubURL
    case invalidEnrollmentCode
    case invalidResponse
    case rejected(statusCode: Int)
    /// The administrator declined this device.
    case declined
    /// Nobody decided within the request's ten minute window.
    case expired
    /// The Hub refuses unencrypted traffic until an operator accepts it there.
    case plaintextNotAccepted
}

/// Where an enrolment has got to, so the UI can say something truthful while
/// the operator waits for someone to approve the device.
public enum AgentEnrollmentStage: Equatable, Sendable {
    case applying
    case awaitingApproval
    case approved
}

/// A submitted application. Held by the caller so a poll can resume after the
/// window is closed and reopened.
public struct AgentEnrollmentTicket: Codable, Equatable, Sendable {
    public let hubURL: URL
    public let requestId: String
    public let claimSecret: String
    public let expiresAt: Date
}

public struct AgentEnrollmentService: Sendable {
    private let transport: any AgentEnrollmentTransport
    private let credentialStore: any AgentCredentialStoring

    public init(
        transport: any AgentEnrollmentTransport = URLSessionAgentEnrollmentTransport(),
        credentialStore: any AgentCredentialStoring = KeychainAgentCredentialStore()
    ) {
        self.transport = transport
        self.credentialStore = credentialStore
    }

    /// Applies to a Hub with a code the operator read off the settings screen.
    ///
    /// Returns a ticket, not a credential: the Hub deliberately does not issue
    /// one until an administrator has looked at the request. Call
    /// `waitForApproval` with the ticket to collect it.
    public func apply(
        hubURL: URL,
        code: String,
        metadata: AgentEnrollmentMetadata
    ) async throws -> AgentEnrollmentTicket {
        guard Self.isAllowedHubURL(hubURL) else {
            throw AgentEnrollmentError.invalidHubURL
        }
        let normalized = Self.normalize(code)
        guard Self.isWellFormedCode(normalized) else {
            throw AgentEnrollmentError.invalidEnrollmentCode
        }

        var request = URLRequest(url: hubURL.appendingPathComponent("api/agent/enrollment-requests"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(ApplyRequest(code: normalized, agent: metadata))

        let (data, response) = try await transport.send(request)
        // 400 here means the Hub is on plain HTTP and nobody has accepted that
        // yet. Saying so lets the operator fix it in one step instead of
        // rechecking the code they just typed correctly.
        if response.statusCode == 400 { throw AgentEnrollmentError.plaintextNotAccepted }
        guard response.statusCode == 202 else {
            throw AgentEnrollmentError.rejected(statusCode: response.statusCode)
        }
        guard let payload = try? JSONDecoder().decode(ApplyResponse.self, from: data),
              payload.claimSecret.range(of: #"^egvc_[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw AgentEnrollmentError.invalidResponse
        }
        return AgentEnrollmentTicket(
            hubURL: hubURL,
            requestId: payload.requestId,
            claimSecret: payload.claimSecret,
            expiresAt: Date(timeIntervalSince1970: TimeInterval(payload.expiresAt) / 1000)
        )
    }

    /// Polls until somebody decides, then stores the credential.
    ///
    /// Every outcome is final except `pending`, so a declined or expired
    /// request stops here rather than retrying forever against a Hub that has
    /// already answered.
    @discardableResult
    public func waitForApproval(
        ticket: AgentEnrollmentTicket,
        pollInterval: TimeInterval = 3,
        now: @Sendable () -> Date = Date.init,
        sleep: @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) }
    ) async throws -> AgentCredential {
        while true {
            if now() > ticket.expiresAt { throw AgentEnrollmentError.expired }
            switch try await claimOnce(ticket: ticket) {
            case .approved(let credential):
                try credentialStore.save(credential)
                return credential
            case .pending:
                try await sleep(pollInterval)
            case .declined:
                throw AgentEnrollmentError.declined
            case .expired:
                throw AgentEnrollmentError.expired
            }
        }
    }

    enum ClaimOutcome {
        case approved(AgentCredential)
        case pending
        case declined
        case expired
    }

    func claimOnce(ticket: AgentEnrollmentTicket) async throws -> ClaimOutcome {
        var request = URLRequest(url: ticket.hubURL.appendingPathComponent("api/agent/enrollment-requests/claim"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(
            ClaimRequest(requestId: ticket.requestId, claimSecret: ticket.claimSecret)
        )

        let (data, response) = try await transport.send(request)
        guard let payload = try? JSONDecoder().decode(ClaimResponse.self, from: data) else {
            throw AgentEnrollmentError.invalidResponse
        }
        switch payload.status {
        case "approved":
            guard response.statusCode == 201,
                  let token = payload.token,
                  let agentIdText = payload.agentId,
                  let agentID = UUID(uuidString: agentIdText),
                  token.range(of: #"^egva_[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
                throw AgentEnrollmentError.invalidResponse
            }
            return .approved(AgentCredential(hubURL: ticket.hubURL, agentID: agentID, token: token))
        case "pending":
            return .pending
        case "rejected":
            return .declined
        // `collected` means this token was already handed out. Treated as
        // declined rather than retried: whatever holds it, this run does not.
        case "expired", "unknown", "collected":
            return payload.status == "rejected" ? .declined : .expired
        default:
            throw AgentEnrollmentError.invalidResponse
        }
    }

    /// Six characters, case-insensitive, with the ambiguous ones left out.
    /// The operator types this once; a transcription slip costs an attempt.
    static func normalize(_ code: String) -> String {
        code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
    }

    static func isWellFormedCode(_ code: String) -> Bool {
        code.range(of: #"^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$"#, options: .regularExpression) != nil
    }

    public static func isAllowedHubURL(_ url: URL) -> Bool {
        guard url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              let scheme = url.scheme?.lowercased(), let host = url.host?.lowercased() else {
            return false
        }
        if scheme == "https" { return true }
        return scheme == "http" && ["localhost", "127.0.0.1", "::1"].contains(host)
    }
}

private struct ApplyRequest: Encodable {
    let code: String
    let agent: AgentEnrollmentMetadata
}

private struct ApplyResponse: Decodable {
    let requestId: String
    let claimSecret: String
    let expiresAt: Int64
}

private struct ClaimRequest: Encodable {
    let requestId: String
    let claimSecret: String
}

private struct ClaimResponse: Decodable {
    let status: String
    let token: String?
    let agentId: String?
}
