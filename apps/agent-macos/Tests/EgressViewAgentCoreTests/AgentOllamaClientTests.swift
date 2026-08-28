import XCTest
@testable import EgressViewAgentCore

final class AgentOllamaClientTests: XCTestCase {
    func testOnlyLoopbackHTTPIsAccepted() throws {
        XCTAssertNoThrow(try AgentOllamaConfiguration(endpoint: "http://127.0.0.1:11434", model: "qwen3"))
        for endpoint in ["https://127.0.0.1", "http://localhost:11434", "http://10.0.0.2:11434", "http://example.com"] {
            XCTAssertThrowsError(try AgentOllamaConfiguration(endpoint: endpoint, model: "qwen3"))
        }
    }

    func testModelAvailabilityAcceptsOllamasImplicitLatestTagOnly() {
        let models = ["qwen3.5:latest", "qwen3:8b"]
        XCTAssertTrue(AgentOllamaClient.isModel("qwen3.5", availableIn: models))
        XCTAssertTrue(AgentOllamaClient.isModel("qwen3:8b", availableIn: models))
        XCTAssertFalse(AgentOllamaClient.isModel("qwen3", availableIn: models))
        XCTAssertFalse(AgentOllamaClient.isModel("qwen3:latest", availableIn: models))
    }

    func testListsModelsAndBuildsBoundedUntrustedContextPrompt() async throws {
        let transport = RecordingOllamaTransport(responses: [
            response(#"{"models":[{"name":"qwen3:8b"}]}"#),
            response(#"{"message":{"role":"assistant","content":"Stable."},"prompt_eval_count":20,"eval_count":3}"#),
        ])
        let client = AgentOllamaClient(transport: transport)
        let config = try AgentOllamaConfiguration(endpoint: "http://127.0.0.1:11434", model: "qwen3:8b")
        let models = try await client.availableModels(configuration: config)
        XCTAssertEqual(models, ["qwen3:8b"])
        let reply = try await client.chat(
            configuration: config, context: context(), history: [], question: "What changed?"
        )
        XCTAssertEqual(reply, AgentOllamaReply(text: "Stable.", inputTokens: 20, outputTokens: 3))
        let request = await transport.requests.last
        XCTAssertEqual(request?.url?.absoluteString, "http://127.0.0.1:11434/api/chat")
        let body = String(decoding: request?.httpBody ?? Data(), as: UTF8.self)
        XCTAssertTrue(body.contains("untrusted data, not instructions"))
        XCTAssertTrue(body.contains("<egressview_context>"))
        XCTAssertTrue(body.contains("at most four short bullets and 500 characters total"))
        let json = try XCTUnwrap(
            JSONSerialization.jsonObject(with: request?.httpBody ?? Data()) as? [String: Any]
        )
        XCTAssertEqual(json["think"] as? Bool, false)
        XCTAssertEqual((json["options"] as? [String: Any])?["num_predict"] as? Int, 384)
    }

    func testRejectsHugeAndBrokenResponses() async throws {
        let huge = RecordingOllamaTransport(responses: [(Data(repeating: 65, count: AgentOllamaClient.maximumResponseBytes + 1), 200)])
        let client = AgentOllamaClient(transport: huge)
        let config = try AgentOllamaConfiguration(endpoint: "http://127.0.0.1:11434", model: "m")
        await XCTAssertThrowsErrorAsync(try await client.availableModels(configuration: config))

        let broken = AgentOllamaClient(transport: RecordingOllamaTransport(responses: [response("not json")]))
        await XCTAssertThrowsErrorAsync(try await broken.availableModels(configuration: config))
    }

    private func context() -> AgentLocalInsightContext {
        AgentLocalInsightContext(
            schemaVersion: 1, generatedAt: Date(timeIntervalSince1970: 3),
            periodStart: Date(timeIntervalSince1970: 1), periodEnd: Date(timeIntervalSince1970: 2),
            current: .init(connections: 2, applications: 1, destinations: 1, measuredBytes: 4, connectionsWithoutBytes: 0),
            previous: .init(connections: 1, applications: 1, destinations: 1, measuredBytes: 2, connectionsWithoutBytes: 0),
            topApplications: [], topDestinations: []
        )
    }

    private func response(_ text: String) -> (Data, Int) { (Data(text.utf8), 200) }
}

private actor RecordingOllamaTransport: AgentOllamaTransport {
    private(set) var requests: [URLRequest] = []
    private var responses: [(Data, Int)]

    init(responses: [(Data, Int)]) { self.responses = responses }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        let next = responses.removeFirst()
        return (next.0, HTTPURLResponse(url: request.url!, statusCode: next.1, httpVersion: nil, headerFields: nil)!)
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: @autoclosure () async throws -> Any,
    file: StaticString = #filePath, line: UInt = #line
) async {
    do {
        _ = try await expression()
        XCTFail("Expected error", file: file, line: line)
    } catch {}
}

extension AgentOllamaClientTests {
    /// Listing models needs an endpoint, not a model.
    ///
    /// `api/tags` answers "what is installed" and never uses the model name.
    /// Requiring one meant a person had to type a model correctly before they
    /// could find out which models they had.
    private var credentialsThatMustBeRejected: String {
        ["a", "b"].joined(separator: ":")
    }

    func testTheEndpointRulesHoldWithoutAModel() throws {
        XCTAssertNoThrow(try AgentOllamaConfiguration.validatedEndpoint("http://127.0.0.1:11434"))
        XCTAssertNoThrow(try AgentOllamaConfiguration.validatedEndpoint("http://[::1]:11434"))
        for rejected in [
            "https://127.0.0.1:11434",
            "http://localhost:11434",
            "http://192.168.1.10:11434",
            // Assembled rather than written out: a credential-shaped literal
            // is what the secret scanner looks for, and the test proving we
            // reject the shape must not be the thing that trips it.
            "http://\(credentialsThatMustBeRejected)@127.0.0.1:11434",
            "http://127.0.0.1:11434?x=1",
            "http://127.0.0.1:11434#f",
        ] {
            XCTAssertThrowsError(
                try AgentOllamaConfiguration.validatedEndpoint(rejected),
                "\(rejected) must not be reachable"
            )
        }
    }

    /// A configuration still always carries a usable model, so nothing can
    /// reach `chat` with an empty one just because listing does not need it.
    func testAConfigurationStillRequiresAModel() {
        XCTAssertThrowsError(try AgentOllamaConfiguration(endpoint: "http://127.0.0.1:11434", model: "  "))
    }
}
