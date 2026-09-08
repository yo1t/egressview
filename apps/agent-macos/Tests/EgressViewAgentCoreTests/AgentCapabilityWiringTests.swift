import Foundation
import XCTest
@testable import EgressViewAgentCore

private final class WiringCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    let credential: AgentCredential
    init(_ credential: AgentCredential) { self.credential = credential }
    func save(_ credential: AgentCredential) {}
    func load() -> AgentCredential? { credential }
    func delete() {}
}

private actor WiringTransport: AgentIngestTransport {
    private(set) var paths: [String] = []
    private(set) var bodies: [Data] = []
    let capabilities: (status: Int, body: Data)

    init(capabilitiesStatus: Int = 200, capabilitiesBody: String = #"{"schemaVersions":[1],"maxObservationsPerBatch":3}"#) {
        capabilities = (capabilitiesStatus, Data(capabilitiesBody.utf8))
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        paths.append(path)
        if path.hasSuffix("capabilities") {
            return (capabilities.body, HTTPURLResponse(url: request.url!, statusCode: capabilities.status, httpVersion: nil, headerFields: nil)!)
        }
        bodies.append(request.httpBody ?? Data())
        return (
            Data(#"{"accepted":0,"duplicate":0,"rejected":0}"#.utf8),
            HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
        )
    }

    func capabilityRequests() -> Int { paths.filter { $0.hasSuffix("capabilities") }.count }
    func sentBodies() -> [Data] { bodies }
}

/// P3-7 Agent側の配線。判定ロジックだけあって誰も呼んでいなかった。
final class AgentCapabilityWiringTests: XCTestCase {
    func testHubにcapabilityを聞く() async throws {
        // The measured starting point: the agent never called this endpoint.
        let (sender, transport, queue) = try make()
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(300))
        let asked = await transport.capabilityRequests()
        XCTAssertGreaterThan(asked, 0, "capability を一度も聞いていない")
    }

    func test一度だけ聞く() async throws {
        // A Hub's version list changes when the Hub restarts, not between two
        // batches a second apart.
        let (sender, transport, queue) = try make()
        try queue.enqueue([observation(), observation(), observation(), observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(600))
        let asked = await transport.capabilityRequests()
        XCTAssertEqual(asked, 1, "batchごとに聞いている（\(asked)回）")
    }

    func testHubの上限を超えて送らない() async throws {
        // The stub Hub accepts three per batch; the agent's own limit is 200.
        let (sender, transport, queue) = try make()
        try queue.enqueue((0..<10).map { _ in observation() })
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(400))
        let bodies = await transport.sentBodies()
        XCTAssertFalse(bodies.isEmpty, "1件も送っていない")
        let payload = try JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any]
        let observations = payload?["observations"] as? [Any] ?? []
        XCTAssertLessThanOrEqual(observations.count, 3, "Hubの上限を超えて送った")
    }

    func test聞けなくても送信を続ける() async throws {
        // A Hub too old to have the endpoint answers 404. Every such Hub still
        // accepts version 1, so stopping here would break a working setup.
        let (sender, transport, queue) = try make(capabilitiesStatus: 404)
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(400))
        let bodies = await transport.sentBodies()
        XCTAssertFalse(bodies.isEmpty, "capability が引けないだけで送信を止めた")
        let payload = try JSONSerialization.jsonObject(with: bodies[0]) as? [String: Any]
        XCTAssertEqual(payload?["schemaVersion"] as? Int, 1)
    }

    // MARK: -

    private func make(capabilitiesStatus: Int = 200) throws -> (AgentIngestSender, WiringTransport, AgentDeliveryQueue) {
        let transport = WiringTransport(capabilitiesStatus: capabilitiesStatus)
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-wiring-\(UUID().uuidString).json")
        )
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: "egva_" + String(repeating: "a", count: 64)
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: WiringCredentialStore(credential),
            transport: transport,
            metadata: AgentIngestMetadata(
                hostName: "test-mac", platform: .macOS,
                osVersion: "26.5.2", agentVersion: "0.5.52"
            )
        )
        return (sender, transport, queue)
    }

    private func observation() -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: "203.0.113.10",
            remotePort: 443,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: Date(),
            lastObservedAt: Date(),
            collector: .networkExtension,
            confidence: .exact
        )
    }
}
