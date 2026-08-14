import Foundation

public protocol AgentUninstallTransport: Sendable {
    func send(_ request: URLRequest) async throws -> HTTPURLResponse
}

public struct URLSessionAgentUninstallTransport: AgentUninstallTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 15) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func send(_ request: URLRequest) async throws -> HTTPURLResponse {
        let (_, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AgentUninstallError.invalidResponse
        }
        return response
    }
}

public enum AgentUninstallError: Error, Equatable {
    case invalidResponse
    case rejected(statusCode: Int)
}

/// Revokes the current Mac at its enrolled Hub before local credentials are
/// removed. A failure is surfaced so the UI can preserve the credential for a
/// retry instead of silently leaving an active server-side identity behind.
public struct AgentUninstallService: Sendable {
    private let transport: any AgentUninstallTransport
    private let credentialStore: any AgentCredentialStoring

    public init(
        transport: any AgentUninstallTransport = URLSessionAgentUninstallTransport(),
        credentialStore: any AgentCredentialStoring = KeychainAgentCredentialStore()
    ) {
        self.transport = transport
        self.credentialStore = credentialStore
    }

    /// Returns false when this Mac was never enrolled and therefore has no Hub
    /// registration to revoke.
    @discardableResult
    public func revokeHubRegistration() async throws -> Bool {
        guard let credential = try credentialStore.load() else { return false }
        var request = URLRequest(
            url: credential.hubURL.appendingPathComponent("api/agent/registration/revoke")
        )
        request.httpMethod = "POST"
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let response = try await transport.send(request)
        guard response.statusCode == 200 else {
            throw AgentUninstallError.rejected(statusCode: response.statusCode)
        }
        return true
    }
}
