import Foundation
import os

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
    private var currentState: AgentIngestSenderState = .off
    private var authorizationBlocked = false
    /// What the Hub said it can accept, once it has been asked (P3-7).
    ///
    /// Cached rather than fetched per batch: a Hub's version list changes when
    /// the Hub restarts, not between two batches a second apart. Nil means
    /// unasked or unanswerable, and both send version 1 -- every Hub accepts
    /// it, so an unanswered question must not stop delivery that works.
    private var hubCapabilities: AgentHubCapabilities?
    /// When the Hub was last asked what it accepts.
    ///
    /// Not a "have we asked" flag any more. The first version asked once per
    /// run and never again, on the reasoning that a Hub too old to answer
    /// would otherwise be asked before every batch forever. That is true and
    /// it also means a Hub that *gains* a capability is never noticed until
    /// the agent restarts -- which is exactly what happened the first time a
    /// Hub gained one (P3-14 stage 2). Asking again on a slow beat costs one
    /// request an hour and keeps the two in step.
    private var capabilitiesAskedAt: Date?
    private static let capabilitiesRefreshInterval: TimeInterval = 60 * 60

    private let logger = Logger(subsystem: "com.egressview.agent.macos", category: "hub-capabilities")

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
            if !enabled {
                publish(.off)
            } else if !connected {
                publish(.waitingForNetwork)
            } else if authorizationBlocked {
                publish(.authorizationRequired)
            } else {
                publish(sendTask == nil ? .idle : currentState)
            }
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
        guard enabled, !authorizationBlocked else { return }
        failureCount = 0
        sendTask?.cancel()
        sendTask = nil
        triggerSend()
    }

    public func currentQueueStatus() -> AgentDeliveryQueueStatus {
        queue.status()
    }

    public func credentialDidChange() {
        authorizationBlocked = false
        failureCount = 0
        if enabled {
            publish(connected ? .idle : .waitingForNetwork)
            triggerSend()
        }
    }

    private func triggerSend() {
        guard enabled, connected, !authorizationBlocked, sendTask == nil else { return }
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
                authorizationBlocked = true
                publish(.authorizationRequired)
                return
            }
            await askCapabilities(credential: credential)
            let outcome = AgentCapabilityNegotiation.decide(capabilities: hubCapabilities)
            let schemaVersion: Int
            switch outcome {
            case let .agreed(version):
                schemaVersion = version
            case let .unknown(fallback):
                schemaVersion = fallback
            case .incompatible:
                // Retrying is pointless and the user has something to do. This
                // is the one capability answer that stops delivery.
                sendTask = nil
                publish(.failed("This Hub does not accept anything this agent can send. Update the Hub or the agent."))
                return
            }
            let limit = AgentCapabilityNegotiation.batchSize(
                capabilities: hubCapabilities, agentLimit: Self.agentBatchLimit
            )
            // Only after this Hub has said it reads the field. A Hub that
            // predates it never lists it, so the payload stays exactly what
            // the shipped strict schema accepts (P3-14 stage 2).
            let includeHostname = AgentCapabilityNegotiation
                .acceptsRemoteHostname(capabilities: hubCapabilities)
            logger.notice("hub-capabilities: includeHostname=\(includeHostname, privacy: .public)")
            guard let envelope = try queue.prepareBatch(
                limit: limit, sentAt: now(), metadata: metadata, schemaVersion: schemaVersion,
                includeHostname: includeHostname
            ) else {
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
                authorizationBlocked = true
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

    /// How many observations this agent is willing to put in one batch.
    ///
    /// The Hub may accept more; that does not make sending more a good idea
    /// here, because the whole batch is held in memory and re-sent on failure.
    static let agentBatchLimit = 200

    /// Asks the Hub what it accepts, and asks again on a slow beat.
    ///
    /// A failure is not fatal -- every Hub still accepts version 1, so
    /// delivery continues -- but it is no longer permanent either. A Hub that
    /// was restarting, unreachable for a moment, or simply older than the
    /// capability being asked about will be asked again within the hour.
    ///
    /// Every outcome is recorded. The first version returned silently from
    /// four different places, so "the Hub does not offer it", "the request
    /// failed", "the answer would not decode" and "it was never asked" were
    /// one indistinguishable nothing from outside -- the same shape of blind
    /// spot that cost two nights on P3-84. `.notice` because `.info` is not
    /// kept in the log store, and `privacy: .public` because a status code and
    /// a field name are not the user's data.
    private func askCapabilities(credential: AgentCredential) async {
        if let askedAt = capabilitiesAskedAt,
           hubCapabilities != nil || now().timeIntervalSince(askedAt) < Self.capabilitiesRefreshInterval {
            return
        }
        capabilitiesAskedAt = now()

        guard AgentEnrollmentService.isAllowedHubURL(credential.hubURL) else {
            logger.notice("hub-capabilities: refused=hub-url-not-allowed")
            return
        }
        var request = URLRequest(url: credential.hubURL.appendingPathComponent("api/agent/capabilities"))
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(credential.token)", forHTTPHeaderField: "Authorization")

        let result: (Data, HTTPURLResponse)
        do {
            result = try await transport.send(request)
        } catch {
            logger.notice("hub-capabilities: request failed, will ask again within the hour")
            return
        }
        guard result.1.statusCode == 200 else {
            logger.notice("hub-capabilities: status=\(result.1.statusCode, privacy: .public)")
            return
        }
        guard let decoded = try? JSONDecoder().decode(AgentHubCapabilities.self, from: result.0) else {
            logger.notice("hub-capabilities: status=200 but the answer would not decode")
            return
        }
        hubCapabilities = decoded
        let fields = decoded.observationFields?.joined(separator: ",") ?? "(none)"
        let versions = decoded.schemaVersions.map(String.init).joined(separator: ",")
        logger.notice(
            "hub-capabilities: status=200 versions=\(versions, privacy: .public) fields=\(fields, privacy: .public)"
        )
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
        currentState = state
        statusHandler(state, queue.status())
    }
}
