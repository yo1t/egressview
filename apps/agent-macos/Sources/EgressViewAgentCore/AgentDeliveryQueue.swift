import Foundation
import Network

public struct AgentDeliveryQueueStatus: Equatable, Sendable {
    public let pendingCount: Int
    public let droppedCount: Int
    public let oldestPendingAt: Date?
    public let lastAcknowledgedAt: Date?
    /// Set when a saved queue could not be read at startup and was reset.
    /// Whatever it held never reached the Hub, so this has to be visible: the
    /// symptom is otherwise missing data with no error anywhere.
    public let unreadableStateResetAt: Date?

    public init(
        pendingCount: Int,
        droppedCount: Int,
        oldestPendingAt: Date?,
        lastAcknowledgedAt: Date?,
        unreadableStateResetAt: Date? = nil
    ) {
        self.pendingCount = pendingCount
        self.droppedCount = droppedCount
        self.oldestPendingAt = oldestPendingAt
        self.lastAcknowledgedAt = lastAcknowledgedAt
        self.unreadableStateResetAt = unreadableStateResetAt
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
        var droppedCount = 0
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
        let invalidIDs = Set(state.pending.compactMap { entry in
            Self.isDeliverable(entry.observation) ? nil : entry.observationID
        })
        if !invalidIDs.isEmpty {
            state.pending.removeAll { invalidIDs.contains($0.observationID) }
            if state.activeBatch?.observationIDs.contains(where: invalidIDs.contains) == true {
                state.activeBatch = nil
            }
            state.droppedCount += invalidIDs.count
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

    public func enqueue(_ observations: [ConnectionObservation], queuedAt: Date = Date()) throws {
        guard !observations.isEmpty else { return }
        try lock.withLock {
            let deliverable = observations.filter(Self.isDeliverable)
            state.droppedCount += observations.count - deliverable.count
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
                droppedCount: state.droppedCount,
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
        state.droppedCount += dropped
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

    private static func isDeliverable(_ observation: ConnectionObservation) -> Bool {
        observation.localPort > 0
            && observation.remotePort > 0
            && isIPAddress(observation.localAddress)
            && isIPAddress(observation.remoteAddress)
            && isSafeText(observation.processName, maximumLength: 256)
            && observation.bundleID.map { isSafeText($0, maximumLength: 255) } ?? true
            && observation.firstObservedAt <= observation.lastObservedAt
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
