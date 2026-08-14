import Foundation
import Testing
@testable import EgressViewAgentCore

private final class UninstallMemoryCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    var credential: AgentCredential?

    init(_ credential: AgentCredential? = nil) {
        self.credential = credential
    }

    func save(_ credential: AgentCredential) { self.credential = credential }
    func load() -> AgentCredential? { credential }
    func delete() { credential = nil }
}

private struct StubUninstallTransport: AgentUninstallTransport {
    let statusCode: Int
    let inspect: @Sendable (URLRequest) throws -> Void

    func send(_ request: URLRequest) async throws -> HTTPURLResponse {
        try inspect(request)
        return HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: nil
        )!
    }
}

@Suite("Agent uninstall registration revocation")
struct AgentUninstallServiceTests {
    @Test("revokes only the enrolled identity and does not delete its credential")
    func revokeRegistration() async throws {
        let token = "egva_" + String(repeating: "a", count: 64)
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: token
        )
        let store = UninstallMemoryCredentialStore(credential)
        let service = AgentUninstallService(
            transport: StubUninstallTransport(statusCode: 200) { request in
                #expect(request.url?.absoluteString == "https://hub.example/api/agent/registration/revoke")
                #expect(request.httpMethod == "POST")
                #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(token)")
            },
            credentialStore: store
        )

        #expect(try await service.revokeHubRegistration())
        #expect(store.credential == credential)
    }

    @Test("does not contact a Hub when this Mac is not enrolled")
    func noCredentialIsNoOp() async throws {
        let service = AgentUninstallService(
            transport: StubUninstallTransport(statusCode: 500) { _ in
                Issue.record("transport must not run without a credential")
            },
            credentialStore: UninstallMemoryCredentialStore()
        )
        #expect(try await !service.revokeHubRegistration())
    }

    @Test("preserves the credential when the Hub cannot revoke it")
    func failedRevocationPreservesCredential() async {
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: "egva_" + String(repeating: "b", count: 64)
        )
        let store = UninstallMemoryCredentialStore(credential)
        let service = AgentUninstallService(
            transport: StubUninstallTransport(statusCode: 503) { _ in },
            credentialStore: store
        )

        await #expect(throws: AgentUninstallError.rejected(statusCode: 503)) {
            try await service.revokeHubRegistration()
        }
        #expect(store.credential == credential)
    }
}
