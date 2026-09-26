import Foundation
import Network

public struct AgentDeliveryQueueStatus: Equatable, Sendable {
    public let pendingCount: Int
    public let contractRejectedCount: Int
    /// How many failed each rule, so a report can say which one.
    public let contractRejectionReasons: [String: Int]
    public let queueOverflowCount: Int
    /// How many observations were given up on after the Hub refused a batch
    /// down to one. Separate from the rejections caught before sending: these
    /// passed this agent's own checks and the Hub still would not take them,
    /// which is the only way to find out that the two disagree.
    public let abandonedCount: Int
    /// How many times a refused batch was halved. Not a loss -- it is how the
    /// one observation the Hub objects to is found without discarding the 199
    /// travelling with it.
    public let splitCount: Int
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
        abandonedCount: Int = 0,
        splitCount: Int = 0,
        legacyUnclassifiedCount: Int,
        oldestPendingAt: Date?,
        lastAcknowledgedAt: Date?,
        unreadableStateResetAt: Date? = nil
    ) {
        self.pendingCount = pendingCount
        self.contractRejectedCount = contractRejectedCount
        self.contractRejectionReasons = contractRejectionReasons
        self.queueOverflowCount = queueOverflowCount
        self.abandonedCount = abandonedCount
        self.splitCount = splitCount
        self.legacyUnclassifiedCount = legacyUnclassifiedCount
        self.oldestPendingAt = oldestPendingAt
        self.lastAcknowledgedAt = lastAcknowledgedAt
        self.unreadableStateResetAt = unreadableStateResetAt
    }

    public var droppedCount: Int {
        contractRejectedCount + queueOverflowCount + abandonedCount + legacyUnclassifiedCount
    }
}

public final class AgentDeliveryQueue: @unchecked Sendable {
    private struct PendingObservation: Codable {
        let observationID: UUID
        var observation: ConnectionObservation
        let queuedAt: Date
    }

    /// A flow whose opening report the Hub has taken, and the id it was
    /// taken under.
    private struct SentOpening: Codable {
        let flowID: UUID
        let observationID: UUID
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
        var abandonedCount: Int?
        var splitCount: Int?
        var lastAcknowledgedAt: Date?
        /// Flows the Hub has an opening row for, oldest first, so that their
        /// closing report can complete that row (P3-170). Optional so queue
        /// files written before it still load.
        var sentOpenings: [SentOpening]?
    }

    private let fileURL: URL
    private let maximumPending: Int
    private let lock = NSLock()
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()
    private var state: State
    private var unreadableStateResetAt: Date?
    /// Whether the Hub completes a stored row when its id comes back with
    /// byte counts. Told by the sender after every capability answer; until
    /// then, and for a Hub that does not, every report gets its own id.
    private var hubCompletesObservations = false
    /// How many opening ids are remembered. A flow's closing report comes
    /// within seconds for almost every flow; a long one whose opening has
    /// been forgotten simply gets its own row, as it did before.
    public static let defaultSentOpeningLimit = 4_096
    private let sentOpeningLimit: Int

    public init(
        fileURL: URL, maximumPending: Int = 10_000,
        sentOpeningLimit: Int = AgentDeliveryQueue.defaultSentOpeningLimit
    ) throws {
        self.fileURL = fileURL
        self.maximumPending = max(1, maximumPending)
        self.sentOpeningLimit = max(1, sentOpeningLimit)
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
                let identity = observation.deliveryIdentity
                if let index = state.pending.lastIndex(where: {
                    !activeIDs.contains($0.observationID) && $0.observation.deliveryIdentity == identity
                }) ?? openingAwaitingClose(for: observation, excluding: activeIDs) {
                    // A later report of the same flow completes the earlier
                    // one rather than replacing it: a closing report that
                    // carries no name must not erase the name found at the
                    // opening. Without a flow the tuple can join two
                    // different connections, so there the newer one is taken
                    // whole, as it always was.
                    let existing = state.pending[index].observation
                    state.pending[index].observation = observation.flowID == nil
                        ? observation
                        : existing.merging(observation)
                } else {
                    state.pending.append(PendingObservation(
                        observationID: takeOpeningID(for: observation) ?? UUID(),
                        observation: observation,
                        queuedAt: queuedAt
                    ))
                }
            }
            trimToLimit()
            try persist()
        }
    }

    /// A queued opening that this closing report completes although their
    /// starts differ.
    ///
    /// A closing report whose flow the extension no longer remembered -- it
    /// restarted, as it does on every update, while the flow was open -- says
    /// the flow started when it closed. It still ends the latest time that
    /// flow opened, the same rule the local history applies.
    private func openingAwaitingClose(
        for observation: ConnectionObservation, excluding activeIDs: Set<UUID>
    ) -> Int? {
        guard observation.hasByteCounts, let flowID = observation.flowID else { return nil }
        return state.pending.lastIndex(where: {
            !activeIDs.contains($0.observationID)
                && $0.observation.flowID == flowID
                && !$0.observation.hasByteCounts
                && $0.observation.firstObservedAt < observation.firstObservedAt
        })
    }

    /// - Parameter schemaVersion: what the Hub said it accepts, or the
    ///   agent's current version when it has not been asked (P3-7).
    public func prepareBatch(
        limit: Int,
        sentAt: Date,
        metadata: AgentIngestMetadata,
        schemaVersion: Int = AgentIngestEnvelope.currentSchemaVersion,
        // Defaults to false so a caller that has not negotiated cannot send
        // the field by omission (P3-14 stage 2).
        includeHostname: Bool = false
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
                byID[id].map {
                    AgentIngestObservation(
                        observationId: id, observation: $0, includeHostname: includeHostname
                    )
                }
            }
            guard observations.count == active.observationIDs.count else {
                throw AgentDeliveryQueueError.corruptActiveBatch
            }
            return AgentIngestEnvelope(
                schemaVersion: schemaVersion,
                batchId: active.batchID,
                sentAt: sentAt,
                agent: metadata,
                observations: observations
            )
        }
    }

    /// What happened to a batch the Hub would not take.
    public enum RejectionOutcome: Equatable, Sendable {
        /// The batch was halved; the next attempt sends this many.
        case split(remaining: Int)
        /// One observation was left and the Hub still refused it, so it was
        /// given up on. Everything that travelled with it has been delivered.
        case abandoned(observationID: UUID)
        /// The rejection named a batch that is not the one in flight, so
        /// nothing was changed. A late reply to a batch already acknowledged
        /// must not cut the batch that replaced it.
        case ignored
    }

    /// Halve a batch the Hub refused, and give up only on the one observation
    /// that survives to the end.
    ///
    /// On Windows this exact situation stopped delivery for three hours and
    /// threw away 42,545 observations: one record in roughly 300 broke the
    /// Hub's contract, and every batch carrying one was refused whole while
    /// the unacknowledged batch was re-sent forever (P3-148). Eight halvings
    /// take 200 observations down to one, so at most one is lost instead of
    /// the 199 travelling with it.
    ///
    /// This agent screens observations before they are queued, so the poison
    /// it knows about never reaches here. This is for the kind it does not
    /// know about -- a Hub whose schema has grown stricter than the agent's
    /// copy of it, which is precisely the case nobody can screen for in
    /// advance.
    public func recordRejection(batchID: UUID) throws -> RejectionOutcome {
        try lock.withLock {
            guard let active = state.activeBatch, active.batchID == batchID else {
                return .ignored
            }
            guard active.observationIDs.count > 1 else {
                let abandoned = active.observationIDs
                state.pending.removeAll { abandoned.contains($0.observationID) }
                state.activeBatch = nil
                state.abandonedCount = (state.abandonedCount ?? 0) + abandoned.count
                try persist()
                // `first` is safe: the guard above is `count > 1`, and an
                // empty batch cannot be prepared.
                return .abandoned(observationID: abandoned[0])
            }
            let keep = Array(active.observationIDs.prefix(active.observationIDs.count / 2))
            // A new id, because the half is a different batch. Reusing the id
            // would let a late acknowledgement of the whole batch clear
            // observations that were never sent.
            state.activeBatch = ActiveBatch(batchID: UUID(), observationIDs: keep)
            state.splitCount = (state.splitCount ?? 0) + 1
            try persist()
            return .split(remaining: keep.count)
        }
    }

    public func acknowledge(batchID: UUID, at date: Date = Date()) throws {
        try lock.withLock {
            guard let active = state.activeBatch, active.batchID == batchID else {
                throw AgentDeliveryQueueError.unexpectedAcknowledgement
            }
            let acknowledged = Set(active.observationIDs)
            rememberOpenings(state.pending.filter { acknowledged.contains($0.observationID) })
            state.pending.removeAll { acknowledged.contains($0.observationID) }
            state.activeBatch = nil
            state.lastAcknowledgedAt = date
            try persist()
        }
    }

    /// Told by the sender whether the Hub completes a stored observation from
    /// a report under the same id (P3-170).
    public func setHubCompletesObservations(_ value: Bool) {
        lock.withLock { hubCompletesObservations = value }
    }

    /// The id of this flow's opening report, if the Hub has it and will
    /// complete it from this report. Used once: a second report with counts
    /// gets its own id rather than two pending entries sharing one.
    private func takeOpeningID(for observation: ConnectionObservation) -> UUID? {
        guard hubCompletesObservations,
              observation.bytesIn != nil || observation.bytesOut != nil,
              let flowID = observation.flowID,
              let index = state.sentOpenings?.firstIndex(where: { $0.flowID == flowID }),
              let observationID = state.sentOpenings?[index].observationID,
              !state.pending.contains(where: { $0.observationID == observationID })
        else { return nil }
        state.sentOpenings?.remove(at: index)
        return observationID
    }

    /// Remembers the flows whose opening report the Hub has just taken without
    /// byte counts, so their closing report can complete that row.
    private func rememberOpenings(_ entries: [PendingObservation]) {
        var openings = state.sentOpenings ?? []
        for entry in entries {
            guard let flowID = entry.observation.flowID else { continue }
            openings.removeAll { $0.flowID == flowID }
            let hasByteCounts = entry.observation.bytesIn != nil || entry.observation.bytesOut != nil
            if !hasByteCounts {
                openings.append(SentOpening(flowID: flowID, observationID: entry.observationID))
            }
        }
        if openings.count > sentOpeningLimit {
            openings.removeFirst(openings.count - sentOpeningLimit)
        }
        state.sentOpenings = openings.isEmpty ? nil : openings
    }

    public func status() -> AgentDeliveryQueueStatus {
        lock.withLock {
            AgentDeliveryQueueStatus(
                pendingCount: state.pending.count,
                contractRejectedCount: state.contractRejectedCount ?? 0,
                contractRejectionReasons: state.contractRejectionReasons ?? [:],
                queueOverflowCount: state.queueOverflowCount ?? 0,
                abandonedCount: state.abandonedCount ?? 0,
                splitCount: state.splitCount ?? 0,
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
