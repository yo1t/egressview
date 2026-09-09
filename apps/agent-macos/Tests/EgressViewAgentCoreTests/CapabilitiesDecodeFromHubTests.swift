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
}
