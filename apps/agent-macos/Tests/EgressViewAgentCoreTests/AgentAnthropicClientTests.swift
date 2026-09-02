import XCTest
@testable import EgressViewAgentCore

final class AgentAnthropicClientTests: XCTestCase {
    func testConfigurationAllowsOnlyPublishedChoices() throws {
        XCTAssertEqual(
            try AgentAnthropicConfiguration(model: "claude-sonnet-5").model,
            "claude-sonnet-5"
        )
        XCTAssertThrowsError(try AgentAnthropicConfiguration(model: "custom-model"))
    }

    func testChatUsesFixedEndpointAndNeverPlacesKeyInBody() async throws {
        let body = #"{"content":[{"type":"text","text":"Review the increase."}],"usage":{"input_tokens":1000,"output_tokens":100}}"#
        let transport = RecordingAnthropicTransport(data: Data(body.utf8), status: 200)
        let client = AgentAnthropicClient(transport: transport)
        let credential = ["fixture", "value"].joined(separator: "-")
        let reply = try await client.chat(
            configuration: try AgentAnthropicConfiguration(model: "claude-sonnet-5"),
            apiKey: credential,
            context: sampleContext(), history: [], question: "What changed?"
        )

        XCTAssertEqual(reply.text, "Review the increase.")
        XCTAssertEqual(reply.inputTokens, 1000)
        XCTAssertEqual(reply.outputTokens, 100)
        XCTAssertEqual(reply.estimatedCostUSD ?? -1, 0.003, accuracy: 0.0000001)
        let request = await transport.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, "https://api.anthropic.com/v1/messages")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "x-api-key"), credential)
        XCTAssertEqual(request?.value(forHTTPHeaderField: "anthropic-version"), "2023-06-01")
        XCTAssertFalse(String(data: request?.httpBody ?? Data(), encoding: .utf8)?.contains(credential) ?? true)
    }

    func testConnectionCheckVerifiesTheSelectedModel() async throws {
        let transport = RecordingAnthropicTransport(data: Data("{}".utf8), status: 200)
        let client = AgentAnthropicClient(transport: transport)
        let credential = ["fixture", "value"].joined(separator: "-")
        try await client.validate(apiKey: credential, model: "claude-haiku-4-5-20251001")
        let request = await transport.lastRequest
        XCTAssertEqual(
            request?.url?.absoluteString,
            "https://api.anthropic.com/v1/models/claude-haiku-4-5-20251001"
        )
        XCTAssertNil(request?.httpBody)
    }

    func testUnknownAnthropicPriceIsUnknownRatherThanZero() {
        XCTAssertNil(AgentAIPriceCatalog.estimatedCostUSD(
            provider: "anthropic", model: "future-model", inputTokens: 10, outputTokens: 10
        ))
    }

    func testRejectsUnauthorizedAndOversizedResponses() async throws {
        let unauthorized = AgentAnthropicClient(transport: RecordingAnthropicTransport(
            data: Data(#"{"type":"error"}"#.utf8), status: 401
        ))
        do {
            try await unauthorized.validate(
                apiKey: "fixture-value", model: "claude-sonnet-5"
            )
            XCTFail("Expected an authorization failure")
        } catch let error as AgentAnthropicError {
            XCTAssertEqual(error, .httpStatus(401))
        }

        let oversized = AgentAnthropicClient(transport: RecordingAnthropicTransport(
            data: Data(repeating: 0x41, count: AgentAnthropicClient.maximumResponseBytes + 1),
            status: 200
        ))
        do {
            try await oversized.validate(
                apiKey: "fixture-value", model: "claude-sonnet-5"
            )
            XCTFail("Expected an oversized response failure")
        } catch let error as AgentAnthropicError {
            XCTAssertEqual(error, .responseTooLarge)
        }
    }

    private func sampleContext() -> AgentLocalInsightContext {
        AgentLocalInsightContext(
            schemaVersion: 1,
            generatedAt: Date(timeIntervalSince1970: 2),
            periodStart: Date(timeIntervalSince1970: 1),
            periodEnd: Date(timeIntervalSince1970: 2),
            current: .init(
                connections: 2, applications: 1, destinations: 1,
                measuredBytes: 20, connectionsWithoutBytes: 0
            ),
            previous: .init(
                connections: 1, applications: 1, destinations: 1,
                measuredBytes: 10, connectionsWithoutBytes: 0
            ),
            topApplications: [],
            topDestinations: []
        )
    }
}

private actor RecordingAnthropicTransport: AgentAnthropicTransport {
    let data: Data
    let status: Int
    private(set) var lastRequest: URLRequest?

    init(data: Data, status: Int) {
        self.data = data
        self.status = status
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        return (
            data,
            HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
        )
    }
}
