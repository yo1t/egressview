import XCTest
@testable import EgressViewAgentCore

/// P3-7 Agent側。Hubのcapabilityから送るschema versionを決める。
final class AgentCapabilityNegotiationTests: XCTestCase {
    func test共通する最も新しいversionを選ぶ() {
        let outcome = AgentCapabilityNegotiation.decide(
            capabilities: AgentHubCapabilities(schemaVersions: [1, 2, 3]),
            agentVersions: [1, 2]
        )
        XCTAssertEqual(outcome, .agreed(schemaVersion: 2))
    }

    func test共通versionが無ければ利用者に伝える() {
        // The one case where retrying is pointless and the user has something
        // to do about it.
        let outcome = AgentCapabilityNegotiation.decide(
            capabilities: AgentHubCapabilities(schemaVersions: [4, 5]),
            agentVersions: [1, 2]
        )
        XCTAssertEqual(outcome, .incompatible(hubVersions: [4, 5], agentVersions: [1, 2]))
        XCTAssertTrue(AgentCapabilityNegotiation.needsUserAttention(outcome))
    }

    func test聞けなかったHubは拒んだHubではない() {
        // 404 from a Hub too old to have the endpoint, 401 from one this agent
        // is not enrolled with, no network at all -- all of them mean the answer
        // is unknown, and every such Hub still accepts version 1. Stopping here
        // would break a configuration that works.
        let outcome = AgentCapabilityNegotiation.decide(capabilities: nil, agentVersions: [1, 2])
        XCTAssertEqual(outcome, .unknown(fallbackSchemaVersion: 1))
    }

    func test聞けなかっただけでは利用者に知らせない() {
        // A warning nobody can act on is what makes the ones that matter go
        // unread. Delivery has not stopped.
        let outcome = AgentCapabilityNegotiation.decide(capabilities: nil)
        XCTAssertFalse(AgentCapabilityNegotiation.needsUserAttention(outcome))
    }

    func test既定の送信versionはHubが常に受理する版() {
        // Not the newest the agent can produce: an old Hub is the case this
        // fallback exists for.
        let outcome = AgentCapabilityNegotiation.decide(capabilities: nil, agentVersions: [3, 1, 2])
        XCTAssertEqual(outcome, .unknown(fallbackSchemaVersion: 1))
    }

    func testHubが受理できる件数を超えて送らない() {
        let capabilities = AgentHubCapabilities(schemaVersions: [1], maxObservationsPerBatch: 200)
        XCTAssertEqual(
            AgentCapabilityNegotiation.batchSize(capabilities: capabilities, agentLimit: 500),
            200
        )
    }

    func testHubが多く受理できてもAgentの上限は超えない() {
        // A Hub may accept more than this agent is willing to send in one go.
        // It may not make it send more.
        let capabilities = AgentHubCapabilities(schemaVersions: [1], maxObservationsPerBatch: 5_000)
        XCTAssertEqual(
            AgentCapabilityNegotiation.batchSize(capabilities: capabilities, agentLimit: 500),
            500
        )
    }

    func test件数を言わないHubにはAgentの上限を使う() {
        XCTAssertEqual(
            AgentCapabilityNegotiation.batchSize(capabilities: nil, agentLimit: 500),
            500
        )
        let silent = AgentHubCapabilities(schemaVersions: [1])
        XCTAssertEqual(
            AgentCapabilityNegotiation.batchSize(capabilities: silent, agentLimit: 500),
            500
        )
    }

    func testHubの応答をそのまま読める() {
        // The shape `GET /api/agent/capabilities` actually serves, including
        // `compression: []` -- declared empty rather than omitted so an agent
        // cannot infer permission from a missing field.
        let json = Data("""
        {"schemaVersions":[1],"maxObservationsPerBatch":500,"maxBodyBytes":1048576,
         "requestsPerMinute":30,"compression":[]}
        """.utf8)
        let decoded = try? JSONDecoder().decode(AgentHubCapabilities.self, from: json)
        XCTAssertEqual(decoded?.schemaVersions, [1])
        XCTAssertEqual(decoded?.maxObservationsPerBatch, 500)
        XCTAssertEqual(decoded?.compression, [])
    }
}
