import Foundation

public struct AgentDeliveryQueueStatus: Equatable, Sendable {
    public let pendingCount: Int
    public let droppedCount: Int
    public let oldestPendingAt: Date?
    public let lastAcknowledgedAt: Date?

    public init(
        pendingCount: Int,
        droppedCount: Int,
        oldestPendingAt: Date?,
        lastAcknowledgedAt: Date?
    ) {
        self.pendingCount = pendingCount
        self.droppedCount = droppedCount
        self.oldestPendingAt = oldestPendingAt
        self.lastAcknowledgedAt = lastAcknowledgedAt
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

    public init(fileURL: URL, maximumPending: Int = 10_000) throws {
        self.fileURL = fileURL
        self.maximumPending = max(1, maximumPending)
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
        if FileManager.default.fileExists(atPath: fileURL.path) {
            state = try decoder.decode(State.self, from: Data(contentsOf: fileURL))
        } else {
            state = State()
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
            let activeIDs = Set(state.activeBatch?.observationIDs ?? [])
            for observation in observations {
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
                lastAcknowledgedAt: state.lastAcknowledgedAt
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
        try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUnlessOpen])
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
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
