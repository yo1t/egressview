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

    @discardableResult
    public func enroll(
        hubURL: URL,
        code: String,
        metadata: AgentEnrollmentMetadata
    ) async throws -> AgentCredential {
        guard Self.isAllowedHubURL(hubURL) else {
            throw AgentEnrollmentError.invalidHubURL
        }
        guard code.range(of: #"^egve_[0-9a-f]{48}$"#, options: .regularExpression) != nil else {
            throw AgentEnrollmentError.invalidEnrollmentCode
        }

        let endpoint = hubURL.appendingPathComponent("api/agent/enroll")
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONEncoder().encode(EnrollmentRequest(code: code, agent: metadata))

        let (data, response) = try await transport.send(request)
        guard response.statusCode == 201 else {
            throw AgentEnrollmentError.rejected(statusCode: response.statusCode)
        }
        guard let payload = try? JSONDecoder().decode(EnrollmentResponse.self, from: data),
              let agentID = UUID(uuidString: payload.agent.agentId),
              payload.token.range(of: #"^egva_[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
            throw AgentEnrollmentError.invalidResponse
        }

        let credential = AgentCredential(hubURL: hubURL, agentID: agentID, token: payload.token)
        try credentialStore.save(credential)
        return credential
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

private struct EnrollmentRequest: Encodable {
    let code: String
    let agent: AgentEnrollmentMetadata
}

private struct EnrollmentResponse: Decodable {
    struct Agent: Decodable {
        let agentId: String
    }

    let token: String
    let agent: Agent
}
