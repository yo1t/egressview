import XCTest
@testable import EgressViewAgentCore

final class CapabilitiesDecodeFromHubTests: XCTestCase {
    /// The exact body this Hub serves, verbatim from src/routes/agents.js.
    func testDecodesTheHubsActualAnswer() throws {
        let json = """
        {"schemaVersions":[1],"maxObservationsPerBatch":200,"maxBodyBytes":524288,
         "requestsPerMinute":60,"compression":[],"observationFields":["remoteHostname"]}
        """
        let caps = try JSONDecoder().decode(AgentHubCapabilities.self, from: Data(json.utf8))
        XCTAssertEqual(caps.observationFields, ["remoteHostname"])
        XCTAssertTrue(AgentCapabilityNegotiation.acceptsRemoteHostname(capabilities: caps))
    }

    /// P3-191: a Hub that stores inbound-probe summaries says so; one that
    /// does not say so is not sent them.
    func testInboundProbesOnlyWhenTheHubSaysSo() throws {
        let json = """
        {"schemaVersions":[1],"compression":[],"observationUpdates":true,"unmeasuredClosings":true,"inboundProbes":true}
        """
        let caps = try JSONDecoder().decode(AgentHubCapabilities.self, from: Data(json.utf8))
        XCTAssertTrue(AgentCapabilityNegotiation.acceptsInboundProbes(capabilities: caps))
        let older = try JSONDecoder().decode(
            AgentHubCapabilities.self, from: Data(#"{"schemaVersions":[1],"compression":[]}"#.utf8)
        )
        XCTAssertFalse(AgentCapabilityNegotiation.acceptsInboundProbes(capabilities: older))
        XCTAssertFalse(AgentCapabilityNegotiation.acceptsInboundProbes(capabilities: nil))
    }
}
