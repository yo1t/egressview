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

    @Test("applying returns a ticket, never a credential")
    func applyReturnsTicketOnly() async throws {
        let response = try JSONSerialization.data(withJSONObject: [
            "requestId": UUID().uuidString,
            "claimSecret": "egvc_" + String(repeating: "c", count: 64),
            "expiresAt": Int(Date().addingTimeInterval(600).timeIntervalSince1970 * 1000),
            "status": "pending",
        ])
        let store = MemoryCredentialStore()
        let transport = StubEnrollmentTransport(statusCode: 202, data: response) { request in
            #expect(request.url?.absoluteString == "https://hub.example/api/agent/enrollment-requests")
            let body = try #require(request.httpBody)
            let json = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
            // Normalised before sending: the operator types this once and must
            // not lose an attempt to their shift key.
            #expect(json["code"] as? String == "PKJZY3")
        }
        let service = AgentEnrollmentService(transport: transport, credentialStore: store)

        let ticket = try await service.apply(
            hubURL: URL(string: "https://hub.example")!,
            code: " pkjzy3 ",
            metadata: metadata
        )

        #expect(ticket.claimSecret.hasPrefix("egvc_"))
        // Nothing is stored yet. An application is not an enrolment.
        #expect(store.load() == nil)
    }

    @Test("a declined request stops instead of polling forever")
    func declinedRequestStops() async throws {
        let response = try JSONSerialization.data(withJSONObject: ["status": "rejected"])
        let service = AgentEnrollmentService(
            transport: StubEnrollmentTransport(statusCode: 200, data: response) { _ in },
            credentialStore: MemoryCredentialStore()
        )
        let ticket = AgentEnrollmentTicket(
            hubURL: URL(string: "https://hub.example")!,
            requestId: UUID().uuidString,
            claimSecret: "egvc_" + String(repeating: "c", count: 64),
            expiresAt: Date().addingTimeInterval(600)
        )
        await #expect(throws: AgentEnrollmentError.declined) {
            try await service.waitForApproval(ticket: ticket, pollInterval: 0, sleep: { _ in })
        }
    }

    @Test("approval stores the bearer and never logs it")
    func approvalStoresCredential() async throws {
        let token = "egva_" + String(repeating: "a", count: 64)
        let agentID = UUID()
        let response = try JSONSerialization.data(withJSONObject: [
            "status": "approved", "token": token, "agentId": agentID.uuidString,
        ])
        let store = MemoryCredentialStore()
        let service = AgentEnrollmentService(
            transport: StubEnrollmentTransport(statusCode: 201, data: response) { request in
                #expect(request.url?.absoluteString == "https://hub.example/api/agent/enrollment-requests/claim")
            },
            credentialStore: store
        )
        let ticket = AgentEnrollmentTicket(
            hubURL: URL(string: "https://hub.example")!,
            requestId: UUID().uuidString,
            claimSecret: "egvc_" + String(repeating: "c", count: 64),
            expiresAt: Date().addingTimeInterval(600)
        )

        let credential = try await service.waitForApproval(ticket: ticket, pollInterval: 0, sleep: { _ in })

        #expect(credential.agentID == agentID)
        #expect(store.load()?.token == token)
        #expect(!credential.description.contains(token))
        #expect(credential.description.contains("<redacted>"))
    }

    @Test("a malformed code is refused before it can burn an attempt")
    func rejectsMalformedCode() async {
        let service = AgentEnrollmentService(
            transport: StubEnrollmentTransport(statusCode: 500, data: Data()) { _ in
                Issue.record("transport must not run for a malformed code")
            },
            credentialStore: MemoryCredentialStore()
        )
        // 0/O and 1/I are not in the alphabet, so they cannot be a real code.
        for value in ["ABC12", "ABCDEFG", "PKJZY0", "PKJZYI", ""] {
            await #expect(throws: AgentEnrollmentError.invalidEnrollmentCode) {
                try await service.apply(
                    hubURL: URL(string: "https://hub.example")!,
                    code: value,
                    metadata: metadata
                )
            }
        }
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
        let credentialURL = ["https://user", "placeholder@hub.example"].joined(separator: ":")
        for value in [
            "http://192.168.1.20",
            credentialURL,
            "https://hub.example?token=value",
        ] {
            await #expect(throws: AgentEnrollmentError.invalidHubURL) {
                try await service.apply(
                    hubURL: URL(string: value)!,
                    code: "PKJZY3",
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
            try await service.apply(
                hubURL: URL(string: "https://hub.example")!,
                code: "PKJZY3",
                metadata: metadata
            )
        }
        #expect(store.load() == nil)
    }
}
