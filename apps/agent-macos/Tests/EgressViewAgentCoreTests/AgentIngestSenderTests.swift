import Foundation
import XCTest
@testable import EgressViewAgentCore

private final class SenderCredentialStore: AgentCredentialStoring, @unchecked Sendable {
    var credential: AgentCredential?

    init(_ credential: AgentCredential?) {
        self.credential = credential
    }

    func save(_ credential: AgentCredential) { self.credential = credential }
    func load() -> AgentCredential? { credential }
    func delete() { credential = nil }
}

private actor SenderTransport: AgentIngestTransport {
    private(set) var requests: [URLRequest] = []
    let response: @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)

    init(response: @escaping @Sendable (URLRequest) throws -> (Data, HTTPURLResponse)) {
        self.response = response
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)
        return try response(request)
    }

    func requestCount() -> Int { requests.count }
}

private actor FlakySenderTransport: AgentIngestTransport {
    private var batchIDs: [UUID] = []

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let envelope = try JSONDecoder.iso8601.decode(
            AgentIngestEnvelope.self,
            from: XCTUnwrap(request.httpBody)
        )
        batchIDs.append(envelope.batchId)
        if batchIDs.count == 1 { throw URLError(.cannotConnectToHost) }
        let data = try JSONEncoder().encode(AgentIngestAcknowledgementFixture(
            batchId: envelope.batchId,
            accepted: envelope.observations.count,
            duplicate: 0,
            rejected: 0,
            replayed: false
        ))
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    func sentBatchIDs() -> [UUID] { batchIDs }
}

final class AgentIngestSenderTests: XCTestCase {
    func testDefaultOffAndDisconnectedStatesNeverSend() async throws {
        let (sender, transport, _) = try makeSender()
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        try await Task.sleep(for: .milliseconds(50))
        var requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 0)

        await sender.setEnabled(true)
        await sender.setConnectivityAvailable(false)
        await sender.sendNow()
        try await Task.sleep(for: .milliseconds(50))
        requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 0)
    }

    func testConnectivityRestorationPushesConfiguredHubAndAcknowledgesBatch() async throws {
        let batchID = LockedValue<UUID?>(nil)
        let transport = SenderTransport { request in
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example/api/agent/ingest")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer egva_" + String(repeating: "a", count: 64))
            let body = try XCTUnwrap(request.httpBody)
            let envelope = try JSONDecoder.iso8601.decode(AgentIngestEnvelope.self, from: body)
            batchID.value = envelope.batchId
            let data = try JSONEncoder().encode(AgentIngestAcknowledgementFixture(
                batchId: envelope.batchId,
                accepted: envelope.observations.count,
                duplicate: 0,
                rejected: 0,
                replayed: false
            ))
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let (sender, _, queue) = try makeSender(transport: transport)
        await sender.enqueue([observation()])
        await sender.setEnabled(true)
        var requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 0)

        await sender.setConnectivityAvailable(true)
        try await waitUntil { queue.status().pendingCount == 0 }

        XCTAssertNotNil(batchID.value)
        requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testUnauthorizedResponseKeepsPendingDataWithoutRetryStorm() async throws {
        let transport = SenderTransport { request in
            (Data(), HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!)
        }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let (sender, _, queue) = try makeSender(transport: transport) { state, _ in
            states.value.append(state)
        }
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { states.value.contains(.authorizationRequired) }
        await sender.enqueue([observation()])
        await sender.sendNow()
        try await Task.sleep(for: .milliseconds(50))

        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(queue.status().pendingCount, 2)
        XCTAssertEqual(states.value.last, .authorizationRequired)
    }

    func testNewCredentialExplicitlyClearsAuthorizationLatch() async throws {
        let attempts = LockedValue(0)
        let transport = SenderTransport { request in
            attempts.value += 1
            if attempts.value == 1 {
                return (Data(), HTTPURLResponse(
                    url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil
                )!)
            }
            let envelope = try JSONDecoder.iso8601.decode(
                AgentIngestEnvelope.self,
                from: XCTUnwrap(request.httpBody)
            )
            let data = try JSONEncoder().encode(AgentIngestAcknowledgementFixture(
                batchId: envelope.batchId,
                accepted: envelope.observations.count,
                duplicate: 0,
                rejected: 0,
                replayed: false
            ))
            return (data, HTTPURLResponse(
                url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil
            )!)
        }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let (sender, _, queue) = try makeSender(transport: transport) { state, _ in
            states.value.append(state)
        }
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { states.value.contains(.authorizationRequired) }

        await sender.credentialDidChange()
        try await waitUntil { queue.status().pendingCount == 0 }

        XCTAssertEqual(attempts.value, 2)
    }

    func testTransientFailureRetriesTheSamePersistedBatch() async throws {
        let transport = FlakySenderTransport()
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-retry-\(UUID().uuidString).json")
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: SenderCredentialStore(AgentCredential(
                hubURL: URL(string: "https://hub.example")!,
                agentID: UUID(),
                token: "egva_" + String(repeating: "a", count: 64)
            )),
            transport: transport,
            metadata: AgentIngestMetadata(
                hostName: "test-mac",
                platform: .macOS,
                osVersion: "26.5.2",
                agentVersion: "0.1.14"
            ),
            retryPolicy: AgentRetryPolicy(initialDelay: 0.01, maximumDelay: 0.02),
            randomUnit: { 1 }
        )
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { queue.status().pendingCount == 0 }

        let batchIDs = await transport.sentBatchIDs()
        XCTAssertEqual(batchIDs.count, 2)
        XCTAssertEqual(Set(batchIDs).count, 1)
    }

    func testNewObservationsDoNotHideScheduledRetryState() async throws {
        let transport = SenderTransport { _ in throw URLError(.cannotConnectToHost) }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-retry-state-\(UUID().uuidString).json")
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: SenderCredentialStore(AgentCredential(
                hubURL: URL(string: "https://hub.example")!,
                agentID: UUID(),
                token: "egva_" + String(repeating: "a", count: 64)
            )),
            transport: transport,
            metadata: AgentIngestMetadata(
                hostName: "test-mac",
                platform: .macOS,
                osVersion: "26.5.2",
                agentVersion: "0.1.14"
            ),
            retryPolicy: AgentRetryPolicy(initialDelay: 30, maximumDelay: 30),
            randomUnit: { 1 },
            statusHandler: { state, _ in states.value.append(state) }
        )
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { states.value.contains { state in
            if case .retryScheduled = state { return true }
            return false
        } }

        await sender.enqueue([observation()])

        guard case .retryScheduled = states.value.last else {
            return XCTFail("new observations must preserve the scheduled retry state")
        }
        let requestCount = await transport.requestCount()
        XCTAssertEqual(requestCount, 1)
    }

    func testRetryPolicyIsBoundedFullJitter() {
        let policy = AgentRetryPolicy()
        XCTAssertEqual(policy.delay(failureCount: 1, randomUnit: 1), 5)
        XCTAssertEqual(policy.delay(failureCount: 2, randomUnit: 0.5), 5)
        XCTAssertEqual(policy.delay(failureCount: 99, randomUnit: 1), 900)
    }

    private func makeSender(
        transport: SenderTransport? = nil,
        statusHandler: @escaping AgentIngestSender.StatusHandler = { _, _ in }
    ) throws -> (AgentIngestSender, SenderTransport, AgentDeliveryQueue) {
        let selectedTransport = transport ?? SenderTransport { request in
            (Data(), HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!)
        }
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-sender-\(UUID().uuidString).json")
        )
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: "egva_" + String(repeating: "a", count: 64)
        )
        return (
            AgentIngestSender(
                queue: queue,
                credentialStore: SenderCredentialStore(credential),
                transport: selectedTransport,
                metadata: AgentIngestMetadata(
                    hostName: "test-mac",
                    platform: .macOS,
                    osVersion: "26.5.2",
                    agentVersion: "0.1.14"
                ),
                statusHandler: statusHandler
            ),
            selectedTransport,
            queue
        )
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

    private func waitUntil(_ condition: @escaping () -> Bool) async throws {
        for _ in 0 ..< 100 where !condition() {
            try await Task.sleep(for: .milliseconds(10))
        }
        XCTAssertTrue(condition())
    }
}

private struct AgentIngestAcknowledgementFixture: Encodable {
    let batchId: UUID
    let accepted: Int
    let duplicate: Int
    let rejected: Int
    let replayed: Bool
}

private final class LockedValue<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Value

    init(_ value: Value) { storage = value }

    var value: Value {
        get { lock.withLock { storage } }
        set { lock.withLock { storage = newValue } }
    }
}

private extension JSONDecoder {
    static var iso8601: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () -> T) -> T {
        lock()
        defer { unlock() }
        return operation()
    }
}
