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
    /// Ingest only. The sender also asks the Hub once what it accepts (P3-7),
    /// and these cases are about delivery, not about that question.
    func ingestCount() -> Int { requests.filter { $0.url?.path.hasSuffix("ingest") ?? false }.count }
    func ingestSizes() -> [Int] {
        requests.filter { $0.url?.path.hasSuffix("ingest") ?? false }.compactMap { request in
            request.httpBody.flatMap { try? JSONDecoder.iso8601.decode(AgentIngestEnvelope.self, from: $0) }?.observations.count
        }
    }
}

private actor FlakySenderTransport: AgentIngestTransport {
    private var batchIDs: [UUID] = []

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        // The capability question carries no body (P3-7). Answer it with
        // nothing useful, so the sender falls back to version 1 -- which is
        // what this case asserted before the question existed.
        guard request.url?.path.hasSuffix("ingest") ?? false else {
            return (Data(), HTTPURLResponse(
                url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil
            )!)
        }
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
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer egva_" + String(repeating: "a", count: 64))
            guard request.url?.path.hasSuffix("ingest") ?? false else {
                // The capability question, answered with nothing useful so the
                // sender falls back to version 1 -- which is what these cases
                // were already asserting before the question existed.
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
            }
            XCTAssertEqual(request.url?.absoluteString, "https://hub.example/api/agent/ingest")
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
        requestCount = await transport.ingestCount()
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

        let requestCount = await transport.ingestCount()
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(queue.status().pendingCount, 2)
        XCTAssertEqual(states.value.last, .authorizationRequired)
    }

    func testNewCredentialExplicitlyClearsAuthorizationLatch() async throws {
        let attempts = LockedValue(0)
        let transport = SenderTransport { request in
            // Count ingest attempts, not every request: the sender also asks
            // the Hub once what it accepts (P3-7), and the 401 under test
            // belongs to delivery.
            guard request.url?.path.hasSuffix("ingest") ?? false else {
                return (Data(), HTTPURLResponse(
                    url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil
                )!)
            }
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
        let requestCount = await transport.ingestCount()
        XCTAssertEqual(requestCount, 1)
    }

    /// P3-186: since 0.5.98 observations arrive every second, and each one
    /// reaching an empty queue went at once -- a batch every two seconds, at
    /// the Hub's thirty a minute, refused with 429 over a thousand times a
    /// day. An arrival soon after a batch now waits out the spacing and goes
    /// with whatever else arrived.
    func testArrivalsSoonAfterABatchWaitAndGoTogether() async throws {
        let transport = Self.acknowledgingTransport()
        let (sender, _, queue) = try makeSender(transport: transport, minimumSendSpacing: 0.6)
        await sender.setEnabled(true)
        await sender.setConnectivityAvailable(true)
        await sender.enqueue([observation()])
        try await waitUntil { queue.status().pendingCount == 0 }
        var sent = await transport.ingestCount()
        XCTAssertEqual(sent, 1, "the first batch is not held back")

        // Distinct flows: the queue keeps one entry per flow.
        await sender.enqueue([observation(remotePort: 444)])
        try await Task.sleep(for: .milliseconds(150))
        await sender.enqueue([observation(remotePort: 445)])
        try await Task.sleep(for: .milliseconds(100))
        sent = await transport.ingestCount()
        XCTAssertEqual(sent, 1, "an arrival right after a batch waits for the spacing")

        try await waitUntil { queue.status().pendingCount == 0 }
        sent = await transport.ingestCount()
        XCTAssertEqual(sent, 2, "both arrivals went as one batch")
        let sizes = await transport.ingestSizes()
        XCTAssertEqual(sizes, [1, 2])
    }

    func testSendNowAndAFullBatchDoNotWaitForTheSpacing() async throws {
        let transport = Self.acknowledgingTransport()
        let (sender, _, queue) = try makeSender(transport: transport, minimumSendSpacing: 30)
        await sender.setEnabled(true)
        await sender.setConnectivityAvailable(true)
        await sender.enqueue([observation()])
        try await waitUntil { queue.status().pendingCount == 0 }

        // Asked for by the person.
        await sender.enqueue([observation()])
        await sender.sendNow()
        try await waitUntil { queue.status().pendingCount == 0 }
        var sent = await transport.ingestCount()
        XCTAssertEqual(sent, 2)

        // A full batch is not made larger by waiting.
        await sender.enqueue((0 ..< AgentIngestSender.agentBatchLimit).map { observation(remotePort: UInt16(1_000 + $0)) })
        try await waitUntil { queue.status().pendingCount == 0 }
        sent = await transport.ingestCount()
        XCTAssertEqual(sent, 3)
    }

    /// 2026-10-31: a queue holding more than one batch drained normally, yet
    /// between batches the sender said it was waiting to retry, which the
    /// settings screen words as "Hub unavailable".
    func testDrainingMoreThanOneBatchIsNotAnnouncedAsARetry() async throws {
        let transport = Self.acknowledgingTransport()
        let states = LockedValue<[AgentIngestSenderState]>([])
        let (sender, _, queue) = try makeSender(
            transport: transport,
            statusHandler: { state, _ in states.value.append(state) }
        )
        await sender.enqueue((0 ..< AgentIngestSender.agentBatchLimit + 5).map { observation(remotePort: UInt16(1_000 + $0)) })
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil(timeout: 10) { queue.status().pendingCount == 0 }

        let sent = await transport.ingestCount()
        XCTAssertEqual(sent, 2)
        XCTAssertFalse(states.value.contains { if case .retryScheduled = $0 { return true }; return false })
        guard case .idle = states.value.last else {
            return XCTFail("a drained queue ends ready, not \(String(describing: states.value.last))")
        }
    }

    /// The batch after a drain is not a failure, so a real failure that
    /// follows starts from the first step of the backoff.
    func testAFailureAfterADrainStartsTheBackoffFromTheFirstStep() async throws {
        let ingests = LockedValue(0)
        let acknowledging = Self.acknowledgingTransport()
        let transport = SenderTransport { request in
            guard request.url?.path.hasSuffix("ingest") ?? false else {
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
            }
            ingests.value += 1
            if ingests.value > 1 { throw URLError(.cannotConnectToHost) }
            return try acknowledging.response(request)
        }
        let states = LockedValue<[(AgentIngestSenderState, Date)]>([])
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-drain-backoff-\(UUID().uuidString).json")
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
            retryPolicy: AgentRetryPolicy(initialDelay: 100, maximumDelay: 900),
            randomUnit: { 1 },
            minimumSendSpacing: 0,
            statusHandler: { state, _ in states.value.append((state, Date())) }
        )
        await sender.enqueue((0 ..< AgentIngestSender.agentBatchLimit + 5).map { observation(remotePort: UInt16(1_000 + $0)) })
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        // The second batch is the one that fails. Before the fix it never
        // went within the test: the drain itself waited out the backoff.
        try await waitUntil(timeout: 10) { ingests.value == 2 }
        try await waitUntil {
            if case .retryScheduled = states.value.last?.0 { return true }
            return false
        }

        guard let (state, at) = states.value.last, case let .retryScheduled(retryAt) = state else {
            return XCTFail("the failure schedules a retry")
        }
        XCTAssertEqual(retryAt.timeIntervalSince(at), 100, accuracy: 5, "the first step of the backoff, not the second (200)")
    }

    private static func acknowledgingTransport() -> SenderTransport {
        SenderTransport { request in
            guard request.url?.path.hasSuffix("ingest") ?? false else {
                return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
            }
            let envelope = try JSONDecoder.iso8601.decode(AgentIngestEnvelope.self, from: XCTUnwrap(request.httpBody))
            let data = try JSONEncoder().encode(AgentIngestAcknowledgementFixture(
                batchId: envelope.batchId,
                accepted: envelope.observations.count,
                duplicate: 0,
                rejected: 0,
                replayed: false
            ))
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }

    /// P3-7, 2026-10-25: against a Hub that speaks no version in common, the
    /// sender stopped and said so in an English sentence the app showed as
    /// it was. It now says why in a form the app puts into the person's
    /// language, and still sends nothing.
    func testAHubWithNoSharedVersionStopsWithAReasonTheAppCanWord() async throws {
        let transport = SenderTransport { request in
            let body = request.url?.path.hasSuffix("capabilities") == true
                ? Data(#"{"schemaVersions":[2],"maxObservationsPerBatch":200,"maxBodyBytes":524288,"requestsPerMinute":30,"compression":[]}"#.utf8)
                : Data()
            return (body, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let (sender, _, _) = try makeSender(
            transport: transport,
            statusHandler: { state, _ in states.value.append(state) }
        )
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        let expected = AgentIngestSenderState.failed(.hubIncompatible(hubVersions: [2], agentVersions: [1]))
        try await waitUntil { states.value.contains(expected) }

        let ingestCount = await transport.ingestCount()
        XCTAssertEqual(ingestCount, 0)
        XCTAssertTrue(AgentIngestFailure.hubIncompatible(hubVersions: [2], agentVersions: [1]).hubIsNewer)
    }

    func testOnlyAHubAheadOfTheAgentAsksForTheAgentToBeUpdated() {
        XCTAssertFalse(AgentIngestFailure.hubIncompatible(hubVersions: [0], agentVersions: [1, 2]).hubIsNewer)
        XCTAssertFalse(AgentIngestFailure.hubIncompatible(hubVersions: [], agentVersions: [1]).hubIsNewer)
        XCTAssertFalse(AgentIngestFailure.rejected(statusCode: 404).hubIsNewer)
    }

    func testARefusalThatARetryWillNotChangeCarriesItsStatus() async throws {
        let transport = SenderTransport { request in
            (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let (sender, _, _) = try makeSender(
            transport: transport,
            statusHandler: { state, _ in states.value.append(state) }
        )
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { states.value.contains(.failed(.rejected(statusCode: 404))) }
    }

    // P3-148, 2026-10-29. Against a real Hub, a batch carrying times two days
    // ahead was halved down to one observation at a time. With this Mac's
    // whole clock ahead, every observation would go that way. The Hub's own
    // date says whose clock is wrong: hold everything and say so.
    func testAClockAheadOfTheHubHoldsTheBatchAndSaysByHowMuch() async throws {
        let hubDate = Self.httpDate(Date().addingTimeInterval(-2 * 86_400))
        let transport = SenderTransport { request in
            if request.url?.path.hasSuffix("capabilities") == true {
                return (Data(#"{"schemaVersions":[1],"maxObservationsPerBatch":200,"maxBodyBytes":524288,"requestsPerMinute":30,"compression":[]}"#.utf8),
                        HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
            return (Data(#"{"error":"Observation window validation failed","rejected":[{"index":0,"reason":"future_timestamp"},{"index":1,"reason":"future_timestamp"}]}"#.utf8),
                    HTTPURLResponse(url: request.url!, statusCode: 422, httpVersion: nil, headerFields: ["Date": hubDate])!)
        }
        let states = LockedValue<[AgentIngestSenderState]>([])
        let failures = LockedValue<[AgentDeliveryFailureRecord]>([])
        let (sender, _, queue) = try makeSender(
            transport: transport,
            statusHandler: { state, _ in states.value.append(state) },
            failureHandler: { failures.value.append($0) }
        )
        await sender.enqueue([observation(), observation(remotePort: 8443)])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil {
            states.value.contains { if case .failed(.clockOff) = $0 { return true }; return false }
        }

        guard case let .failed(.clockOff(seconds)) = states.value.last else { return XCTFail("\(states.value)") }
        XCTAssertEqual(Double(seconds), 2 * 86_400, accuracy: 5)
        let ingests = await transport.ingestCount()
        XCTAssertEqual(ingests, 1, "not re-sent, not halved")
        XCTAssertEqual(queue.status().pendingCount, 2)
        XCTAssertEqual(queue.status().splitCount, 0)
        XCTAssertEqual(queue.status().abandonedCount, 0)
        XCTAssertEqual(failures.value.last?.statusCode, 422)
    }

    func testOnlyATimeRefusalWithClocksApartIsBlamedOnTheClock() {
        let now = Date()
        let future = Data(#"{"rejected":[{"index":0,"reason":"future_timestamp"}]}"#.utf8)
        let old = Data(#"{"rejected":[{"index":0,"reason":"outside_retention"}]}"#.utf8)
        let mixed = Data(#"{"rejected":[{"index":0,"reason":"future_timestamp"},{"index":1,"reason":"something_else"}]}"#.utf8)
        let hubBehind = Self.httpDate(now.addingTimeInterval(-2 * 86_400))
        let hubAhead = Self.httpDate(now.addingTimeInterval(40 * 86_400))
        let hubSame = Self.httpDate(now)

        XCTAssertEqual(AgentIngestSender.clockSkew(body: future, hubDate: hubBehind, now: now) ?? 0, 2 * 86_400, accuracy: 2)
        XCTAssertEqual(AgentIngestSender.clockSkew(body: old, hubDate: hubAhead, now: now) ?? 0, -40 * 86_400, accuracy: 2)
        XCTAssertNil(AgentIngestSender.clockSkew(body: future, hubDate: hubSame, now: now), "the observation, not the clock")
        XCTAssertNil(AgentIngestSender.clockSkew(body: future, hubDate: hubAhead, now: now), "the wrong direction explains nothing")
        XCTAssertNil(AgentIngestSender.clockSkew(body: mixed, hubDate: hubBehind, now: now))
        XCTAssertNil(AgentIngestSender.clockSkew(body: future, hubDate: nil, now: now))
        XCTAssertNil(AgentIngestSender.clockSkew(body: Data(), hubDate: hubBehind, now: now))
    }

    func testAServerErrorIsRecordedWithItsStatusForTheReport() async throws {
        let failures = LockedValue<[AgentDeliveryFailureRecord]>([])
        let (sender, _, _) = try makeSender(failureHandler: { failures.value.append($0) })
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        try await waitUntil { failures.value.contains { $0.statusCode == 500 } }
        XCTAssertEqual(failures.value.first { $0.statusCode == 500 }?.what, "Hub error")
    }

    func testANetworkErrorIsRecordedWithoutItsMessage() {
        let described = AgentIngestSender.describeForDiagnostics(URLError(.cannotConnectToHost))
        XCTAssertEqual(described, "no answer (URLError -1004)")
    }

    // "Send now" cancels the attempt in flight and starts another. The
    // cancelled one used to schedule a retry of its own when its request
    // came back cancelled, so two attempts ran and the report named the
    // cancellation as the last failure (URLError -999).
    func testSendNowDuringAnAttemptLeavesNoFailureAndNoSecondAttempt() async throws {
        let transport = SlowFirstTransport()
        let states = LockedValue<[AgentIngestSenderState]>([])
        let failures = LockedValue<[AgentDeliveryFailureRecord]>([])
        let queue = try AgentDeliveryQueue(
            fileURL: FileManager.default.temporaryDirectory
                .appendingPathComponent("egressview-sender-\(UUID().uuidString).json")
        )
        let sender = AgentIngestSender(
            queue: queue,
            credentialStore: SenderCredentialStore(AgentCredential(
                hubURL: URL(string: "https://hub.example")!, agentID: UUID(),
                token: "egva_" + String(repeating: "a", count: 64)
            )),
            transport: transport,
            metadata: AgentIngestMetadata(hostName: "test-mac", platform: .macOS, osVersion: "26.5.2", agentVersion: "0.1.14"),
            minimumSendSpacing: 0,
            statusHandler: { state, _ in states.value.append(state) },
            failureHandler: { failures.value.append($0) }
        )
        await sender.enqueue([observation()])
        await sender.setConnectivityAvailable(true)
        await sender.setEnabled(true)
        for _ in 0 ..< 100 where await transport.ingestCount() == 0 {
            try await Task.sleep(for: .milliseconds(10))
        }
        await sender.sendNow()
        try await waitUntil { queue.status().pendingCount == 0 }
        try await Task.sleep(for: .milliseconds(300))

        XCTAssertTrue(failures.value.isEmpty, "\(failures.value)")
        XCTAssertFalse(states.value.contains { if case .retryScheduled = $0 { return true }; return false })
        let ingests = await transport.ingestCount()
        XCTAssertEqual(ingests, 2, "the cancelled attempt and the one that replaced it, and no third")
    }

    private static func httpDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.string(from: date)
    }

    func testRetryPolicyIsBoundedFullJitter() {
        let policy = AgentRetryPolicy()
        XCTAssertEqual(policy.delay(failureCount: 1, randomUnit: 1), 5)
        XCTAssertEqual(policy.delay(failureCount: 2, randomUnit: 0.5), 5)
        XCTAssertEqual(policy.delay(failureCount: 99, randomUnit: 1), 900)
    }

    private func makeSender(
        transport: SenderTransport? = nil,
        minimumSendSpacing: TimeInterval = 0,
        statusHandler: @escaping AgentIngestSender.StatusHandler = { _, _ in },
        failureHandler: @escaping @Sendable (AgentDeliveryFailureRecord) -> Void = { _ in }
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
                minimumSendSpacing: minimumSendSpacing,
                statusHandler: statusHandler,
                failureHandler: failureHandler
            ),
            selectedTransport,
            queue
        )
    }

    private func observation(remotePort: UInt16 = 443) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 49_152,
            remoteAddress: "203.0.113.10",
            remotePort: remotePort,
            processID: 42,
            processName: "TestApp",
            firstObservedAt: Date(),
            lastObservedAt: Date(),
            collector: .networkExtension,
            confidence: .exact
        )
    }

    private func waitUntil(timeout: TimeInterval = 1, _ condition: @escaping () -> Bool) async throws {
        for _ in 0 ..< Int(timeout * 100) where !condition() {
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

/// Holds the first ingest until it is cancelled, as URLSession does, then
/// acknowledges everything after it.
private actor SlowFirstTransport: AgentIngestTransport {
    private var ingests = 0

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        guard request.url?.path.hasSuffix("ingest") ?? false else {
            return (Data(), HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!)
        }
        ingests += 1
        if ingests == 1 {
            while !Task.isCancelled { try? await Task.sleep(for: .milliseconds(5)) }
            throw URLError(.cancelled)
        }
        let envelope = try JSONDecoder.iso8601.decode(AgentIngestEnvelope.self, from: XCTUnwrap(request.httpBody))
        let data = try JSONEncoder().encode(AgentIngestAcknowledgementFixture(
            batchId: envelope.batchId, accepted: envelope.observations.count,
            duplicate: 0, rejected: 0, replayed: false
        ))
        return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }

    func ingestCount() -> Int { ingests }
}
