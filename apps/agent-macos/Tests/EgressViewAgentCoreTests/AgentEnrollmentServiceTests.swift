import Foundation
import Testing
@testable import EgressViewAgentCore

private final class MemoryCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var value: AgentCredential?

    func save(_ credential: AgentCredential) {
        lock.withLock { value = credential }
    }

    func load() -> AgentCredential? {
        lock.withLock { value }
    }

    func delete() {
        lock.withLock { value = nil }
    }
}

private struct StubEnrollmentTransport: AgentEnrollmentTransport {
    let statusCode: Int
    let data: Data
    let inspect: @Sendable (URLRequest) throws -> Void

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        try inspect(request)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        return (data, response)
    }
}

@Suite("Agent enrollment and credential storage")
struct AgentEnrollmentServiceTests {
    private let metadata = AgentEnrollmentMetadata(
        hostName: "test-mac",
        platform: "macos",
        osVersion: "26.5.2",
        agentVersion: "0.1.13"
    )

    @Test("successful enrollment stores the returned bearer without logging it")
    func enrollsAndStoresCredential() async throws {
        let token = "egva_" + String(repeating: "a", count: 64)
        let agentID = UUID()
        let response = try JSONSerialization.data(withJSONObject: [
            "token": token,
            "agent": ["agentId": agentID.uuidString],
        ])
        let store = MemoryCredentialStore()
        let transport = StubEnrollmentTransport(statusCode: 201, data: response) { request in
            #expect(request.url?.absoluteString == "https://hub.example/api/agent/enroll")
            #expect(request.httpMethod == "POST")
            let body = try #require(request.httpBody)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            #expect(json["code"] as? String == "egve_" + String(repeating: "b", count: 48))
        }
        let service = AgentEnrollmentService(transport: transport, credentialStore: store)

        let credential = try await service.enroll(
            hubURL: URL(string: "https://hub.example")!,
            code: "egve_" + String(repeating: "b", count: 48),
            metadata: metadata
        )

        #expect(credential.agentID == agentID)
        #expect(store.load()?.token == token)
        #expect(!credential.description.contains(token))
        #expect(credential.description.contains("<redacted>"))
    }

    @Test("plaintext LAN hubs and credentials embedded in URLs are refused before transport")
    func rejectsUnsafeHubURLs() async {
        let transport = StubEnrollmentTransport(statusCode: 500, data: Data()) { _ in
            Issue.record("transport must not run for an unsafe URL")
        }
        let service = AgentEnrollmentService(
            transport: transport,
            credentialStore: MemoryCredentialStore()
        )
        for value in [
            "http://192.168.1.20",
            "https://user:password@hub.example",
            "https://hub.example?token=value",
        ] {
            await #expect(throws: AgentEnrollmentError.invalidHubURL) {
                try await service.enroll(
                    hubURL: URL(string: value)!,
                    code: "egve_" + String(repeating: "b", count: 48),
                    metadata: metadata
                )
            }
        }
    }

    @Test("HTTP is accepted only for loopback development")
    func allowsLoopbackDevelopment() {
        #expect(AgentEnrollmentService.isAllowedHubURL(URL(string: "http://127.0.0.1:3002")!))
        #expect(AgentEnrollmentService.isAllowedHubURL(URL(string: "http://[::1]:3002")!))
        #expect(!AgentEnrollmentService.isAllowedHubURL(URL(string: "http://192.168.1.20:3002")!))
    }

    @Test("rejected enrollment never writes a credential")
    func rejectedEnrollmentDoesNotWrite() async {
        let store = MemoryCredentialStore()
        let transport = StubEnrollmentTransport(statusCode: 401, data: Data()) { _ in }
        let service = AgentEnrollmentService(transport: transport, credentialStore: store)

        await #expect(throws: AgentEnrollmentError.rejected(statusCode: 401)) {
            try await service.enroll(
                hubURL: URL(string: "https://hub.example")!,
                code: "egve_" + String(repeating: "b", count: 48),
                metadata: metadata
            )
        }
        #expect(store.load() == nil)
    }
}
