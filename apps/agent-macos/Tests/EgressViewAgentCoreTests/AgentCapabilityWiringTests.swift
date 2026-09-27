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
    /// One status per capability ask; the last one repeats.
    private var statuses: [Int]
    let body: Data

    init(capabilitiesStatus: Int = 200, capabilitiesBody: String = #"{"schemaVersions":[1],"maxObservationsPerBatch":3}"#) {
        self.init(capabilitiesStatuses: [capabilitiesStatus], capabilitiesBody: capabilitiesBody)
    }

    init(capabilitiesStatuses: [Int], capabilitiesBody: String = #"{"schemaVersions":[1],"maxObservationsPerBatch":3}"#) {
        statuses = capabilitiesStatuses
        body = Data(capabilitiesBody.utf8)
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let path = request.url?.path ?? ""
        paths.append(path)
        if path.hasSuffix("capabilities") {
            let status = statuses.count > 1 ? statuses.removeFirst() : statuses[0]
            return (body, HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
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

    func test答えが得られたらbatchごとには聞き直さない() async throws {
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

    func test聞けなかったときは同じプロセスの中でも聞き直す() async throws {
        // The first version asked once per run and never again. A Hub that was
        // restarting when the agent started, or that gained a capability
        // afterwards, was therefore never noticed until the agent restarted --
        // and a Hub gaining one is exactly what happened the first time
        // (P3-14 stage 2). Failure must not be permanent.
        let clock = TestClock()
        let (sender, transport, queue) = try make(capabilitiesStatus: 503, clock: clock)
        try queue.enqueue([observation(), observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(300))
        let first = await transport.capabilityRequests()
        XCTAssertEqual(first, 1)

        // An hour later, by the sender's own clock.
        clock.advance(by: 3_601)
        try queue.enqueue([observation()])
        // Nudge the loop the way a reconnect would, rather than waiting for
        // whatever interval it happens to use.
        await sender.setConnectivityAvailable(false)
        await sender.setConnectivityAvailable(true)
        try await Task.sleep(for: .milliseconds(600))
        let second = await transport.capabilityRequests()
        XCTAssertGreaterThan(second, first, "失敗したまま二度と聞き直していない")
    }

    func test起動直後に聞けなくても一時間待たずに聞き直す() async throws {
        // P3-179: the ask three seconds after an update failed, and the next
        // one came an hour later.
        let clock = TestClock()
        let (sender, transport, queue) = try make(capabilitiesStatuses: [503, 200], clock: clock)
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await Task.sleep(for: .milliseconds(300))
        let asked1 = await transport.capabilityRequests()
        XCTAssertEqual(asked1, 1)

        // Ten seconds on: too soon to ask again.
        clock.advance(by: 10)
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(false)
        await sender.setConnectivityAvailable(true)
        try await Task.sleep(for: .milliseconds(300))
        let asked2 = await transport.capabilityRequests()
        XCTAssertEqual(asked2, 1, "失敗の直後に聞き直し続けている")

        // Half a minute after the failure: asked again, not an hour later.
        clock.advance(by: 25)
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(false)
        await sender.setConnectivityAvailable(true)
        try await Task.sleep(for: .milliseconds(300))
        let asked3 = await transport.capabilityRequests()
        XCTAssertEqual(asked3, 2, "30秒たっても聞き直していない")

        // Answered: not asked again.
        clock.advance(by: 3_601)
        try queue.enqueue([observation()])
        await sender.setConnectivityAvailable(false)
        await sender.setConnectivityAvailable(true)
        try await Task.sleep(for: .milliseconds(300))
        let asked4 = await transport.capabilityRequests()
        XCTAssertEqual(asked4, 2)
    }

    func test聞き直す間隔は倍々で一時間まで() {
        let intervals = (1...9).map { AgentIngestSender.capabilityRetryInterval(afterFailures: $0) }
        XCTAssertEqual(intervals, [30, 60, 120, 240, 480, 960, 1_920, 3_600, 3_600])
        XCTAssertEqual(AgentIngestSender.capabilityRetryInterval(afterFailures: 0), 0)
        XCTAssertEqual(AgentIngestSender.capabilityRetryInterval(afterFailures: 1_000), 3_600)
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

    /// A clock the test moves, so an hour can pass without waiting one.
    private final class TestClock: @unchecked Sendable {
        private let lock = NSLock()
        private var value = Date(timeIntervalSince1970: 1_800_000_000)
        func now() -> Date { lock.withLock { value } }
        func advance(by seconds: TimeInterval) { lock.withLock { value += seconds } }
    }

    private func make(
        capabilitiesStatus: Int = 200,
        capabilitiesStatuses: [Int]? = nil,
        clock: TestClock? = nil
    ) throws -> (AgentIngestSender, WiringTransport, AgentDeliveryQueue) {
        let transport = WiringTransport(capabilitiesStatuses: capabilitiesStatuses ?? [capabilitiesStatus])
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-wiring-\(UUID().uuidString).json")
        )
        let credential = AgentCredential(
            hubURL: URL(string: "https://hub.example")!,
            agentID: UUID(),
            token: "egva_" + String(repeating: "a", count: 64)
        )
        // Spelled out rather than `clock.map { ... } ?? { ... }`. That form
        // needs the checker to resolve a closure returned from a closure
        // through `??`, which this toolchain does and the one CI uses does
        // not -- it built here and failed there.
        let nowProvider: @Sendable () -> Date
        if let clock {
            nowProvider = { clock.now() }
        } else {
            nowProvider = { Date() }
        }
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: WiringCredentialStore(credential),
            transport: transport,
            metadata: AgentIngestMetadata(
                hostName: "test-mac", platform: .macOS,
                osVersion: "26.5.2", agentVersion: "0.5.52"
            ),
            now: nowProvider
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
