import Foundation
import XCTest
@testable import EgressViewAgentCore

private final class ChangedHubCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    let credential: AgentCredential
    init(_ credential: AgentCredential) { self.credential = credential }
    func save(_ credential: AgentCredential) {}
    func load() -> AgentCredential? { credential }
    func delete() {}
}

/// A Hub whose answers can change while the agent runs.
private actor ChangingHub: AgentIngestTransport {
    /// What `/capabilities` answers.
    var capabilities: String
    /// Whether ingest accepts `remoteHostname`. The shipped schema is strict,
    /// so a Hub built before the field refuses a batch that carries it.
    var readsHostname: Bool
    /// Refuse the next N ingests as the wrong schema version.
    var versionRefusals: Int
    /// A remote port this Hub refuses whatever else is in the batch.
    var poisonPort: Int?
    private(set) var capabilityRequests = 0
    private(set) var ingestSizes: [Int] = []

    init(capabilities: String, readsHostname: Bool, versionRefusals: Int = 0, poisonPort: Int? = nil) {
        self.capabilities = capabilities
        self.readsHostname = readsHostname
        self.versionRefusals = versionRefusals
        self.poisonPort = poisonPort
    }

    func rollBack(capabilities: String, readsHostname: Bool) {
        self.capabilities = capabilities
        self.readsHostname = readsHostname
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        if url.path.hasSuffix("capabilities") {
            capabilityRequests += 1
            return (Data(capabilities.utf8), Self.response(url, 200))
        }
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let observations = json["observations"] as? [[String: Any]] ?? []
        ingestSizes.append(observations.count)
        if versionRefusals > 0 {
            versionRefusals -= 1
            return (Data(#"{"error":"unsupported_schema_version","requested":1,"supported":[1]}"#.utf8), Self.response(url, 400))
        }
        if let poisonPort, observations.contains(where: { $0["remotePort"] as? Int == poisonPort }) {
            return (Data(#"{"error":"Invalid request"}"#.utf8), Self.response(url, 400))
        }
        if !readsHostname, observations.contains(where: { $0["remoteHostname"] != nil }) {
            return (Data(#"{"error":"Invalid request"}"#.utf8), Self.response(url, 400))
        }
        let ack = """
        {"batchId":"\(json["batchId"] as? String ?? "")","accepted":\(observations.count),"duplicate":0,"rejected":0,"replayed":false}
        """
        return (Data(ack.utf8), Self.response(url, 200))
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

/// The Hub the agent talks to can become an older one while the agent runs --
/// restored from a backup, rolled back after a bad update. The agent kept the
/// first answer about what the Hub accepts for the whole run, so it went on
/// sending what the new-old Hub refuses, and the refusal handling (#632) then
/// halved every batch down to one observation and gave each one up.
final class AgentHubChangedUnderneathTests: XCTestCase {
    private let newHub = #"{"schemaVersions":[1],"maxObservationsPerBatch":200,"observationFields":["remoteHostname"]}"#
    private let oldHub = #"{"schemaVersions":[1],"maxObservationsPerBatch":200}"#

    func test古いHubに戻っても記録を一件も捨てずに送り切る() async throws {
        let hub = ChangingHub(capabilities: newHub, readsHostname: true)
        let (sender, queue) = try make(hub)
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        await sender.enqueue([observation(port: 1)])
        try await waitUntil { queue.status().pendingCount == 0 }

        // The Hub is restored to a build that predates the field.
        await hub.rollBack(capabilities: oldHub, readsHostname: false)
        await sender.enqueue((10..<18).map { observation(port: UInt16($0)) })
        try await waitUntil(seconds: 10) { queue.status().pendingCount == 0 }

        XCTAssertEqual(queue.status().abandonedCount, 0, "Hubが戻っただけで記録を捨てた")
        XCTAssertEqual(queue.status().splitCount, 0, "Hubが戻っただけでバッチを分割した")
        let asked = await hub.capabilityRequests
        XCTAssertGreaterThanOrEqual(asked, 2, "拒否されてもHubに聞き直していない")
    }

    /// A version refusal is not about any observation in the batch. Halving
    /// it would only begin cutting records that are not at fault.
    func test版の拒否ではバッチを分割しない() async throws {
        let hub = ChangingHub(capabilities: oldHub, readsHostname: false, versionRefusals: 1)
        let (sender, queue) = try make(hub)
        try queue.enqueue((10..<14).map { observation(port: UInt16($0)) })
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil(seconds: 10) { queue.status().pendingCount == 0 }

        let sizes = await hub.ingestSizes
        XCTAssertEqual(sizes.first, 4)
        XCTAssertEqual(sizes.dropFirst().first, 4, "版の拒否でバッチを分割した: \(sizes)")
        XCTAssertEqual(queue.status().splitCount, 0)
        XCTAssertEqual(queue.status().abandonedCount, 0)
        let asked = await hub.capabilityRequests
        XCTAssertGreaterThanOrEqual(asked, 2, "版を拒否されてもHubに聞き直していない")
    }

    /// Asking again must not become a way to never cut. An observation the
    /// Hub refuses under a fresh answer is still set apart, and only it.
    func test聞き直しても拒まれる一件は従来どおり切り離す() async throws {
        let hub = ChangingHub(capabilities: newHub, readsHostname: true, poisonPort: 13)
        let (sender, queue) = try make(hub)
        try queue.enqueue((10..<18).map { observation(port: UInt16($0)) })
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil(seconds: 10) { queue.status().pendingCount == 0 }

        XCTAssertEqual(queue.status().abandonedCount, 1)
    }

    func test版の拒否は本文で見分ける() {
        XCTAssertTrue(AgentIngestSender.refusesTheVersion(Data(#"{"error":"unsupported_schema_version"}"#.utf8)))
        XCTAssertFalse(AgentIngestSender.refusesTheVersion(Data(#"{"error":"Invalid request"}"#.utf8)))
        XCTAssertFalse(AgentIngestSender.refusesTheVersion(Data()))
        XCTAssertFalse(AgentIngestSender.refusesTheVersion(Data("not json".utf8)))
    }

    // MARK: -

    private func make(_ hub: ChangingHub) throws -> (AgentIngestSender, AgentDeliveryQueue) {
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-changed-hub-\(UUID().uuidString).json")
        )
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: "egva_" + String(repeating: "a", count: 64)
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: ChangedHubCredentialStore(credential),
            transport: hub,
            metadata: AgentIngestMetadata(
                hostName: "test-mac", platform: .macOS, osVersion: "26.5.2", agentVersion: "0.5.87"
            ),
            // No waiting between attempts: the backoff is not what is being
            // tested, and a real one would outlast the test.
            retryPolicy: AgentRetryPolicy(initialDelay: 0.01, maximumDelay: 0.05)
        )
        return (sender, queue)
    }

    private func observation(port: UInt16) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: "203.0.113.10",
            remotePort: port,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: Date(),
            lastObservedAt: Date(),
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: "api.example",
            flowID: UUID()
        )
    }

    private func waitUntil(seconds: Double = 3, _ condition: @escaping () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertTrue(condition())
    }
}
