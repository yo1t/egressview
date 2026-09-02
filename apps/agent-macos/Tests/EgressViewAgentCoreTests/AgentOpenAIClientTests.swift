import XCTest
@testable import EgressViewAgentCore

final class AgentOpenAIClientTests: XCTestCase {
    func testConfigurationAllowsOnlyPublishedChoices() throws {
        XCTAssertEqual(try AgentOpenAIConfiguration(model: "gpt-5.6-luna").model, "gpt-5.6-luna")
        XCTAssertThrowsError(try AgentOpenAIConfiguration(model: "custom-model"))
    }

    func testChatUsesFixedEndpointAndNeverPlacesKeyInBody() async throws {
        let body = #"{"output":[{"content":[{"type":"output_text","text":"Check the increase."}]}],"usage":{"input_tokens":1000,"output_tokens":100}}"#
        let transport = RecordingOpenAITransport(data: Data(body.utf8), status: 200)
        let client = AgentOpenAIClient(transport: transport)
        let credential = ["fixture", "value"].joined(separator: "-")
        let reply = try await client.chat(
            configuration: try AgentOpenAIConfiguration(model: "gpt-5.6-luna"),
            apiKey: credential,
            context: sampleContext(), history: [], question: "What changed?"
        )
        XCTAssertEqual(reply.text, "Check the increase.")
        XCTAssertEqual(reply.inputTokens, 1000)
        XCTAssertEqual(reply.outputTokens, 100)
        XCTAssertEqual(reply.estimatedCostUSD ?? -1, 0.00032, accuracy: 0.0000001)
        let request = await transport.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, "https://api.openai.com/v1/responses")
        XCTAssertEqual(request?.value(forHTTPHeaderField: "Authorization"), "Bearer \(credential)")
        XCTAssertFalse(String(data: request?.httpBody ?? Data(), encoding: .utf8)?.contains(credential) ?? true)
    }

    func testConnectionCheckVerifiesTheSelectedModel() async throws {
        let transport = RecordingOpenAITransport(data: Data("{}".utf8), status: 200)
        let client = AgentOpenAIClient(transport: transport)
        let credential = ["fixture", "value"].joined(separator: "-")
        try await client.validate(apiKey: credential, model: "gpt-5.6-luna")
        let request = await transport.lastRequest
        XCTAssertEqual(request?.url?.absoluteString, "https://api.openai.com/v1/models/gpt-5.6-luna")
        XCTAssertNil(request?.httpBody)
    }

    func testUnknownPriceIsUnknownRatherThanZero() {
        XCTAssertNil(AgentAIPriceCatalog.estimatedCostUSD(
            provider: "openai", model: "future-model", inputTokens: 10, outputTokens: 10
        ))
        XCTAssertNil(AgentAIPriceCatalog.estimatedCostUSD(
            provider: "ollama", model: "qwen", inputTokens: 10, outputTokens: 10
        ))
    }

    private func sampleContext() -> AgentLocalInsightContext {
        AgentLocalInsightContext(
            schemaVersion: 1, generatedAt: Date(timeIntervalSince1970: 2),
            periodStart: Date(timeIntervalSince1970: 1), periodEnd: Date(timeIntervalSince1970: 2),
            current: .init(connections: 2, applications: 1, destinations: 1, measuredBytes: 20, connectionsWithoutBytes: 0),
            previous: .init(connections: 1, applications: 1, destinations: 1, measuredBytes: 10, connectionsWithoutBytes: 0),
            topApplications: [], topDestinations: []
        )
    }
}

private actor RecordingOpenAITransport: AgentOpenAITransport {
    let data: Data
    let status: Int
    private(set) var lastRequest: URLRequest?

    init(data: Data, status: Int) { self.data = data; self.status = status }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        lastRequest = request
        return (data, HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
        )!)
    }
}
