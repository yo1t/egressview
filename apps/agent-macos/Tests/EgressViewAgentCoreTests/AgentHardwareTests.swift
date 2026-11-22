import Foundation
import XCTest
@testable import EgressViewAgentCore

private final class HardwareCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    let credential = AgentCredential(
        hubURL: URL(string: "https://hub.example")!,
        agentID: UUID(),
        token: "egva_" + String(repeating: "a", count: 64)
    )
    func save(_ credential: AgentCredential) {}
    func load() -> AgentCredential? { credential }
    func delete() {}
}

/// A Hub that records the `agent` object of each batch and, like the shipped
/// strict schema, refuses fields it has not listed.
private actor HardwareHub: AgentIngestTransport {
    let capabilities: String
    let readsHardware: Bool
    private(set) var agents: [[String: Any]] = []

    init(capabilities: String, readsHardware: Bool) {
        self.capabilities = capabilities
        self.readsHardware = readsHardware
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        if url.path.hasSuffix("capabilities") {
            return (Data(capabilities.utf8), Self.response(url, 200))
        }
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        let agent = json["agent"] as? [String: Any] ?? [:]
        agents.append(agent)
        if !readsHardware, agent["manufacturer"] != nil || agent["model"] != nil {
            return (Data(#"{"error":"Invalid request"}"#.utf8), Self.response(url, 400))
        }
        let count = (json["observations"] as? [Any])?.count ?? 0
        let ack = """
        {"batchId":"\(json["batchId"] as? String ?? "")","accepted":\(count),"duplicate":0,"rejected":0,"replayed":false}
        """
        return (Data(ack.utf8), Self.response(url, 200))
    }

    private static func response(_ url: URL, _ status: Int) -> HTTPURLResponse {
        HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
    }
}

/// P3-199: the Mac tells the Hub who made it and which model it is, so the
/// device list can say so when a randomized MAC hides the vendor. Only a Hub
/// that has said it reads them is sent them.
final class AgentHardwareTests: XCTestCase {
    func testメーカーと機種はHubが受け取ると言ったときだけ送る() async throws {
        let newer = HardwareHub(
            capabilities: #"{"schemaVersions":[1],"agentFields":["manufacturer","model"]}"#, readsHardware: true
        )
        let sentToNewer = try await deliver(to: newer)
        XCTAssertEqual(sentToNewer["manufacturer"] as? String, "Apple")
        XCTAssertEqual(sentToNewer["model"] as? String, "Mac14,2")

        let older = HardwareHub(capabilities: #"{"schemaVersions":[1]}"#, readsHardware: false)
        let sentToOlder = try await deliver(to: older)
        XCTAssertNil(sentToOlder["manufacturer"], "古いHubにメーカーを送った")
        XCTAssertNil(sentToOlder["model"], "古いHubに機種を送った")
        XCTAssertEqual(sentToOlder["hostName"] as? String, "test-mac")
    }

    func test片方しか挙げないHubには送らない() throws {
        let caps = try JSONDecoder().decode(
            AgentHubCapabilities.self,
            from: Data(#"{"schemaVersions":[1],"agentFields":["manufacturer"]}"#.utf8)
        )
        XCTAssertFalse(AgentCapabilityNegotiation.acceptsHardware(capabilities: caps))
        XCTAssertFalse(AgentCapabilityNegotiation.acceptsHardware(capabilities: nil))
    }

    func testこのMacの機種名を読める() throws {
        let model = try XCTUnwrap(MacHardwareModel.current())
        XCTAssertFalse(model.isEmpty)
        XCTAssertLessThanOrEqual(model.count, 100)
    }

    // MARK: -

    private func deliver(to hub: HardwareHub) async throws -> [String: Any] {
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-hardware-\(UUID().uuidString).json")
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: HardwareCredentialStore(),
            transport: hub,
            metadata: AgentIngestMetadata(
                hostName: "test-mac", platform: .macOS, osVersion: "26.5.2", agentVersion: "0.5.146",
                manufacturer: "Apple", model: "Mac14,2"
            ),
            retryPolicy: AgentRetryPolicy(initialDelay: 0.01, maximumDelay: 0.05)
        )
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        await sender.enqueue([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
            remoteAddress: "203.0.113.10", remotePort: 443, processID: 42, processName: "TestApp",
            firstObservedAt: Date(), lastObservedAt: Date(), collector: .networkExtension, confidence: .exact,
            flowID: UUID()
        )])
        let deadline = Date().addingTimeInterval(5)
        while queue.status().pendingCount > 0, Date() < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertEqual(queue.status().pendingCount, 0)
        let agents = await hub.agents
        XCTAssertEqual(agents.count, 1, "拒否されて送り直した: \(agents.count)")
        return try XCTUnwrap(agents.first)
    }
}
