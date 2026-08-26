import Foundation
import Network

public struct AgentDeliveryQueueStatus: Equatable, Sendable {
    public let pendingCount: Int
    public let contractRejectedCount: Int
    /// How many failed each rule, so a report can say which one.
    public let contractRejectionReasons: [String: Int]
    public let queueOverflowCount: Int
    public let legacyUnclassifiedCount: Int
    public let oldestPendingAt: Date?
    public let lastAcknowledgedAt: Date?
    /// Set when a saved queue could not be read at startup and was reset.
    /// Whatever it held never reached the Hub, so this has to be visible: the
    /// symptom is otherwise missing data with no error anywhere.
    public let unreadableStateResetAt: Date?

    public init(
        pendingCount: Int,
        contractRejectedCount: Int,
        contractRejectionReasons: [String: Int] = [:],
        queueOverflowCount: Int,
        legacyUnclassifiedCount: Int,
        oldestPendingAt: Date?,
        lastAcknowledgedAt: Date?,
        unreadableStateResetAt: Date? = nil
    ) {
        self.pendingCount = pendingCount
        self.contractRejectedCount = contractRejectedCount
        self.contractRejectionReasons = contractRejectionReasons
        self.queueOverflowCount = queueOverflowCount
        self.legacyUnclassifiedCount = legacyUnclassifiedCount
        self.oldestPendingAt = oldestPendingAt
        self.lastAcknowledgedAt = lastAcknowledgedAt
        self.unreadableStateResetAt = unreadableStateResetAt
    }

    public var droppedCount: Int {
        contractRejectedCount + queueOverflowCount + legacyUnclassifiedCount
    }
}

public final class AgentDeliveryQueue: @unchecked Sendable {
    private struct PendingObservation: Codable {
        let observationID: UUID
        var observation: ConnectionObservation
        let queuedAt: Date
    }

    private struct ActiveBatch: Codable {
        let batchID: UUID
        let observationIDs: [UUID]
    }

    private struct State: Codable {
        var pending: [PendingObservation] = []
        var activeBatch: ActiveBatch?
        // Written by Agent 0.2.0 and earlier. Its two causes cannot be safely
        // reconstructed, so preserve it as an explicitly unclassified total.
        var droppedCount = 0
        var contractRejectedCount: Int?
        // Optional for compatibility with queue files written before this
        // counter existed. Missing data means "not classified", not corrupt.
        var contractRejectionReasons: [String: Int]?
        var queueOverflowCount: Int?
        var lastAcknowledgedAt: Date?
    }

    private let fileURL: URL
    private let maximumPending: Int
    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var state: State
    private var unreadableStateResetAt: Date?

    public init(fileURL: URL, maximumPending: Int = 10_000) throws {
        self.fileURL = fileURL
        self.maximumPending = max(1, maximumPending)
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            state = State()
            return
        }
        do {
            state = try decoder.decode(State.self, from: Data(contentsOf: fileURL))
        } catch {
            // A saved queue that cannot be read must not stop the agent from
            // collecting. Refusing to start would turn one lost buffer into an
            // agent that delivers nothing until someone notices -- and nobody
            // notices, because the symptom is missing data rather than an
            // error. Start empty and report it instead.
            //
            // Agents built before 2026-08-14 wrote this file with a protection
            // class that leaves it unreadable afterwards, so existing installs
            // reach this path once. Its contents cannot be recovered: changing
            // the attribute afterwards does not make the bytes readable.
            state = State()
            unreadableStateResetAt = Date()
            try? FileManager.default.removeItem(at: fileURL)
            return
        }
        var reasons: [ContractRejection: Int] = [:]
        let invalidIDs = Set(state.pending.compactMap { entry -> UUID? in
            guard let reason = Self.contractRejection(entry.observation) else { return nil }
            reasons[reason, default: 0] += 1
            return entry.observationID
        })
        if !invalidIDs.isEmpty {
            state.pending.removeAll { invalidIDs.contains($0.observationID) }
            if state.activeBatch?.observationIDs.contains(where: invalidIDs.contains) == true {
                state.activeBatch = nil
            }
            state.contractRejectedCount = (state.contractRejectedCount ?? 0) + invalidIDs.count
            // Counts per rule, not the observations themselves.
            var reasonCounts = state.contractRejectionReasons ?? [:]
            for (reason, count) in reasons {
                reasonCounts[reason.rawValue, default: 0] += count
            }
            state.contractRejectionReasons = reasonCounts
            try persist()
        }
    }

    public convenience init(fileManager: FileManager = .default) throws {
        guard let containerURL = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: ObservationJournal.appGroupIdentifier
        ) else {
            throw ObservationJournalError.appGroupUnavailable
        }
        try self.init(fileURL: containerURL.appendingPathComponent("pending-ingest.json"))
    }

    public static func removePersistedQueue(fileManager: FileManager = .default) throws {
        guard let containerURL = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: ObservationJournal.appGroupIdentifier
        ) else {
            throw ObservationJournalError.appGroupUnavailable
        }
        let fileURL = containerURL.appendingPathComponent("pending-ingest.json")
        if fileManager.fileExists(atPath: fileURL.path) {
            try fileManager.removeItem(at: fileURL)
        }
    }

    public func enqueue(_ observations: [ConnectionObservation], queuedAt: Date = Date()) throws {
        guard !observations.isEmpty else { return }
        try lock.withLock {
            var deliverable: [ConnectionObservation] = []
            deliverable.reserveCapacity(observations.count)
            for observation in observations {
                guard let reason = Self.contractRejection(observation) else {
                    deliverable.append(observation)
                    continue
                }
                // The rule it failed, not the observation. A count on its own
                // says something was discarded and leaves the reader to go
                // read this function to find out what -- which is what
                // `contractRejectedCount = 4` cost on 2026-08-24.
                var reasonCounts = state.contractRejectionReasons ?? [:]
                reasonCounts[reason.rawValue, default: 0] += 1
                state.contractRejectionReasons = reasonCounts
            }
            state.contractRejectedCount = (state.contractRejectedCount ?? 0)
                + observations.count - deliverable.count
            let activeIDs = Set(state.activeBatch?.observationIDs ?? [])
            for observation in deliverable {
                if let index = state.pending.lastIndex(where: {
                    !activeIDs.contains($0.observationID) && $0.observation.stableKey == observation.stableKey
                }) {
                    state.pending[index].observation = observation
                } else {
                    state.pending.append(PendingObservation(
                        observationID: UUID(),
                        observation: observation,
                        queuedAt: queuedAt
                    ))
                }
            }
            trimToLimit()
            try persist()
        }
    }

    public func prepareBatch(
        limit: Int,
        sentAt: Date,
        metadata: AgentIngestMetadata
    ) throws -> AgentIngestEnvelope? {
        try lock.withLock {
            guard !state.pending.isEmpty else { return nil }
            let active: ActiveBatch
            if let existing = state.activeBatch {
                active = existing
            } else {
                active = ActiveBatch(
                    batchID: UUID(),
                    observationIDs: state.pending.prefix(max(1, min(200, limit))).map(\.observationID)
                )
                state.activeBatch = active
                try persist()
            }
            let byID = Dictionary(uniqueKeysWithValues: state.pending.map { ($0.observationID, $0.observation) })
            let observations = active.observationIDs.compactMap { id in
                byID[id].map { AgentIngestObservation(observationId: id, observation: $0) }
            }
            guard observations.count == active.observationIDs.count else {
                throw AgentDeliveryQueueError.corruptActiveBatch
            }
            return AgentIngestEnvelope(
                batchId: active.batchID,
                sentAt: sentAt,
                agent: metadata,
                observations: observations
            )
        }
    }

    public func acknowledge(batchID: UUID, at date: Date = Date()) throws {
        try lock.withLock {
            guard let active = state.activeBatch, active.batchID == batchID else {
                throw AgentDeliveryQueueError.unexpectedAcknowledgement
            }
            let acknowledged = Set(active.observationIDs)
            state.pending.removeAll { acknowledged.contains($0.observationID) }
            state.activeBatch = nil
            state.lastAcknowledgedAt = date
            try persist()
        }
    }

    public func status() -> AgentDeliveryQueueStatus {
        lock.withLock {
            AgentDeliveryQueueStatus(
                pendingCount: state.pending.count,
                contractRejectedCount: state.contractRejectedCount ?? 0,
                contractRejectionReasons: state.contractRejectionReasons ?? [:],
                queueOverflowCount: state.queueOverflowCount ?? 0,
                legacyUnclassifiedCount: state.droppedCount,
                oldestPendingAt: state.pending.map(\.queuedAt).min(),
                lastAcknowledgedAt: state.lastAcknowledgedAt,
                unreadableStateResetAt: unreadableStateResetAt
            )
        }
    }

    private func trimToLimit() {
        let overflow = state.pending.count - maximumPending
        guard overflow > 0 else { return }
        let activeIDs = Set(state.activeBatch?.observationIDs ?? [])
        var remaining = overflow
        var dropped = 0
        state.pending = state.pending.filter { entry in
            guard remaining > 0, !activeIDs.contains(entry.observationID) else { return true }
            remaining -= 1
            dropped += 1
            return false
        }
        state.queueOverflowCount = (state.queueOverflowCount ?? 0) + dropped
    }

    private func persist() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let data = try encoder.encode(state)
        // The queue must survive a restart, so protection has to allow reading
        // once the user has logged in. `.completeFileProtectionUnlessOpen`,
        // used until 2026-08-14, leaves the file unreadable afterwards and
        // silently discards everything that had not reached the Hub.
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    /// Which rule an observation failed, if any.
    ///
    /// The count alone said four observations were discarded and nothing said
    /// why -- on 2026-08-24 that number had been 4 for days and the only way
    /// to find out what it meant was to read this function. A rule name is not
    /// the observation: it carries no address, no process and no time, so
    /// keeping it costs nothing anyone would object to.
    public enum ContractRejection: String, Codable, Equatable, Sendable {
        case remotePortZero
        case localAddressNotAnIP
        case remoteAddressNotAnIP
        case processNameUnusable
        case bundleIDUnusable
        case timesReversed
    }

    static func contractRejection(_ observation: ConnectionObservation) -> ContractRejection? {
        if observation.remotePort <= 0 { return .remotePortZero }
        if !isIPAddress(observation.localAddress) { return .localAddressNotAnIP }
        if !isIPAddress(observation.remoteAddress) { return .remoteAddressNotAnIP }
        if !isSafeText(observation.processName, maximumLength: 256) { return .processNameUnusable }
        if let bundleID = observation.bundleID, !isSafeText(bundleID, maximumLength: 255) {
            return .bundleIDUnusable
        }
        if observation.firstObservedAt > observation.lastObservedAt { return .timesReversed }
        return nil
    }

    private static func isIPAddress(_ value: String) -> Bool {
        IPv4Address(value) != nil || IPv6Address(value) != nil
    }

    private static func isSafeText(_ value: String, maximumLength: Int) -> Bool {
        !value.isEmpty
            && value.count <= maximumLength
            && value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
}

public enum AgentDeliveryQueueError: Error, Equatable {
    case corruptActiveBatch
    case unexpectedAcknowledgement
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
