import Foundation

public struct AgentIngestAcknowledgement: Decodable, Equatable, Sendable {
    public let batchId: UUID
    public let accepted: Int
    public let duplicate: Int
    public let rejected: Int
    public let replayed: Bool
}

public protocol AgentIngestTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionAgentIngestTransport: AgentIngestTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 20) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AgentIngestSenderError.invalidResponse
        }
        return (data, response)
    }
}

public struct AgentRetryPolicy: Equatable, Sendable {
    public let initialDelay: TimeInterval
    public let maximumDelay: TimeInterval

    public init(initialDelay: TimeInterval = 5, maximumDelay: TimeInterval = 15 * 60) {
        self.initialDelay = initialDelay
        self.maximumDelay = maximumDelay
    }

    public func delay(failureCount: Int, randomUnit: Double) -> TimeInterval {
        let exponent = min(max(0, failureCount - 1), 20)
        let ceiling = min(maximumDelay, initialDelay * pow(2, Double(exponent)))
        return ceiling * min(1, max(0, randomUnit))
    }
}

public enum AgentIngestSenderState: Equatable, Sendable {
    case off
    case paused
    case waitingForNetwork
    case idle
    case sending
    case retryScheduled(Date)
    case authorizationRequired
    case failed(String)
}

public enum AgentIngestSenderError: Error, Equatable {
    case invalidResponse
    case invalidAcknowledgement
    case rejected(statusCode: Int)
}

public actor AgentIngestSender {
    public typealias StatusHandler = @Sendable (AgentIngestSenderState, AgentDeliveryQueueStatus) -> Void

    private let queue: AgentDeliveryQueue
    private let credentialStore: any AgentCredentialStoring
    private let transport: any AgentIngestTransport
    private let metadata: AgentIngestMetadata
    private let retryPolicy: AgentRetryPolicy
    private let randomUnit: @Sendable () -> Double
    private let now: @Sendable () -> Date
    private let statusHandler: StatusHandler
    private var enabled = false
    private var connected = false
    private var failureCount = 0
    private var sendTask: Task<Void, Never>?

    public init(
        queue: AgentDeliveryQueue,
        credentialStore: any AgentCredentialStoring = KeychainAgentCredentialStore(),
        transport: any AgentIngestTransport = URLSessionAgentIngestTransport(),
        metadata: AgentIngestMetadata,
        retryPolicy: AgentRetryPolicy = AgentRetryPolicy(),
        randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0 ... 1) },
        now: @escaping @Sendable () -> Date = { Date() },
        statusHandler: @escaping StatusHandler = { _, _ in }
    ) {
        self.queue = queue
        self.credentialStore = credentialStore
        self.transport = transport
        self.metadata = metadata
        self.retryPolicy = retryPolicy
        self.randomUnit = randomUnit
        self.now = now
        self.statusHandler = statusHandler
    }

    public func setEnabled(_ value: Bool) {
        enabled = value
        if value {
            publish(connected ? .idle : .waitingForNetwork)
            triggerSend()
        } else {
            sendTask?.cancel()
            sendTask = nil
            publish(.off)
        }
    }

    public func pause() {
        enabled = false
        sendTask?.cancel()
        sendTask = nil
        publish(.paused)
    }

    public func enqueue(_ observations: [ConnectionObservation]) {
        do {
            try queue.enqueue(observations, queuedAt: now())
            publish(enabled ? (connected ? .idle : .waitingForNetwork) : .off)
            triggerSend()
        } catch {
            publish(.failed("Pending observations could not be stored"))
        }
    }

    public func setConnectivityAvailable(_ value: Bool) {
        connected = value
        guard enabled else { return }
        if value {
            failureCount = 0
            publish(.idle)
            triggerSend()
        } else {
            sendTask?.cancel()
            sendTask = nil
            publish(.waitingForNetwork)
        }
    }

    public func sendNow() {
        guard enabled else { return }
        failureCount = 0
        sendTask?.cancel()
        sendTask = nil
        triggerSend()
    }

    public func currentQueueStatus() -> AgentDeliveryQueueStatus {
        queue.status()
    }

    private func triggerSend() {
        guard enabled, connected, sendTask == nil else { return }
        sendTask = Task { [weak self] in
            await self?.sendNextBatch()
        }
    }

    private func sendNextBatch() async {
        guard enabled, connected, !Task.isCancelled else {
            sendTask = nil
            return
        }
        do {
            guard let credential = try credentialStore.load() else {
                sendTask = nil
                publish(.authorizationRequired)
                return
            }
            guard let envelope = try queue.prepareBatch(limit: 200, sentAt: now(), metadata: metadata) else {
                sendTask = nil
                publish(.idle)
                return
            }
            publish(.sending)
            let request = try makeRequest(credential: credential, envelope: envelope)
            let (data, response) = try await transport.send(request)
            guard !Task.isCancelled else {
                sendTask = nil
                return
            }
            if response.statusCode == 401 || response.statusCode == 403 {
                sendTask = nil
                publish(.authorizationRequired)
                return
            }
            if response.statusCode == 429 {
                let retryAfter = TimeInterval(response.value(forHTTPHeaderField: "Retry-After") ?? "")
                scheduleRetry(minimumDelay: retryAfter)
                return
            }
            guard response.statusCode == 200 else {
                if response.statusCode >= 500 {
                    scheduleRetry()
                } else {
                    sendTask = nil
                    publish(.failed("Hub rejected the pending batch (HTTP \(response.statusCode))"))
                }
                return
            }
            let acknowledgement = try JSONDecoder().decode(AgentIngestAcknowledgement.self, from: data)
            guard acknowledgement.batchId == envelope.batchId,
                  acknowledgement.rejected == 0,
                  acknowledgement.accepted + acknowledgement.duplicate == envelope.observations.count else {
                throw AgentIngestSenderError.invalidAcknowledgement
            }
            try queue.acknowledge(batchID: envelope.batchId, at: now())
            failureCount = 0
            sendTask = nil
            publish(.idle)
            if queue.status().pendingCount > 0 {
                scheduleRetry(minimumDelay: 2.1)
            }
        } catch is CancellationError {
            sendTask = nil
            return
        } catch {
            scheduleRetry()
        }
    }

    private func makeRequest(
        credential: AgentCredential,
        envelope: AgentIngestEnvelope
    ) throws -> URLRequest {
        guard AgentEnrollmentService.isAllowedHubURL(credential.hubURL) else {
            throw AgentIngestSenderError.rejected(statusCode: 0)
        }
        var request = URLRequest(url: credential.hubURL.appendingPathComponent("api/agent/ingest"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        request.httpBody = try encoder.encode(envelope)
        return request
    }

    private func scheduleRetry(minimumDelay: TimeInterval? = nil) {
        sendTask = nil
        guard enabled, connected else {
            publish(enabled ? .waitingForNetwork : .off)
            return
        }
        failureCount += 1
        let jittered = retryPolicy.delay(failureCount: failureCount, randomUnit: randomUnit())
        let delay = min(retryPolicy.maximumDelay, max(minimumDelay ?? 1, jittered))
        let retryAt = now().addingTimeInterval(delay)
        publish(.retryScheduled(retryAt))
        sendTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            await self?.sendNextBatch()
        }
    }

    private func publish(_ state: AgentIngestSenderState) {
        statusHandler(state, queue.status())
    }
}
