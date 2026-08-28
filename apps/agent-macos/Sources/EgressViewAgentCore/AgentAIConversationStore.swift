import Foundation

public enum AgentAIMessageRole: String, Codable, Sendable {
    case user
    case assistant
}

public enum AgentAIMessageStatus: String, Codable, Sendable {
    case complete
    case failed
}

public struct AgentAIConversationMessage: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public let conversationID: UUID
    public let requestID: UUID
    public let role: AgentAIMessageRole
    public let body: String
    public let createdAt: Date
    public let provider: String
    public let model: String
    public let status: AgentAIMessageStatus
    public let errorCode: String?
    public let inputTokens: Int?
    public let outputTokens: Int?

    public init(
        id: UUID = UUID(), conversationID: UUID, requestID: UUID,
        role: AgentAIMessageRole, body: String, createdAt: Date = Date(),
        provider: String = "ollama", model: String,
        status: AgentAIMessageStatus = .complete, errorCode: String? = nil,
        inputTokens: Int? = nil, outputTokens: Int? = nil
    ) {
        self.id = id
        self.conversationID = conversationID
        self.requestID = requestID
        self.role = role
        self.body = body
        self.createdAt = createdAt
        self.provider = provider
        self.model = model
        self.status = status
        self.errorCode = errorCode
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
    }
}

/// A delete flag, written as its own line.
///
/// The store is a JSONL file, so the equivalent of setting a flag on a row is
/// appending a record that marks it deleted. `clearsAllBefore` covers "delete
/// everything" without listing every id, and applies only to what was written
/// before it -- a later message is not retroactively deleted.
public struct AgentAIConversationDeletion: Codable, Equatable, Sendable {
    public let deletedMessageIDs: [UUID]
    public let clearsAllBefore: Bool
    public let deletedAt: Date

    public init(deletedMessageIDs: [UUID], clearsAllBefore: Bool, deletedAt: Date = Date()) {
        self.deletedMessageIDs = deletedMessageIDs
        self.clearsAllBefore = clearsAllBefore
        self.deletedAt = deletedAt
    }
}

public final class AgentAIConversationStore: @unchecked Sendable {
    public static let maximumFileBytes = 20 * 1_048_576

    private let fileURL: URL
    private let lock = NSLock()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL) throws {
        self.fileURL = fileURL
        encoder = JSONEncoder()
        decoder = JSONDecoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        decoder.dateDecodingStrategy = .iso8601
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            FileManager.default.createFile(atPath: fileURL.path, contents: nil)
        }
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }

    public convenience init(fileManager: FileManager = .default) throws {
        guard let container = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: ObservationJournal.appGroupIdentifier
        ) else { throw ObservationJournalError.appGroupUnavailable }
        try self.init(fileURL: container.appendingPathComponent("ai-conversations.jsonl"))
    }

    public func append(_ message: AgentAIConversationMessage) throws {
        try lock.withLock {
            var line = try encoder.encode(message)
            line.append(0x0A)
            let size = currentFileSize()
            guard size + line.count <= Self.maximumFileBytes else {
                throw AgentAIConversationStoreError.historyFull
            }
            let handle = try FileHandle(forWritingTo: fileURL)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
            try handle.synchronize()
        }
    }

    /// Mark messages deleted by appending a deletion record.
    ///
    /// The file stays append-only: nothing already written is rewritten, so a
    /// crash or a full disk cannot truncate history that was never asked
    /// about. A deleted message stops being returned by `messages()` and stops
    /// appearing on screen; its line remains in the file.
    ///
    /// **That is a deliberate difference from observation history**, where
    /// [P3-43] settled that delete removes the rows. Anyone reading this file
    /// directly still sees deleted text.
    @discardableResult
    public func delete(ids: Set<UUID>) throws -> Int {
        guard !ids.isEmpty else { return 0 }
        return try lock.withLock {
            let visible = Set(try applyDeletions(to: try decodedLines()).map(\.id))
            let effective = ids.intersection(visible)
            guard !effective.isEmpty else { return 0 }
            try appendDeletion(
                AgentAIConversationDeletion(
                    deletedMessageIDs: Array(effective).sorted { $0.uuidString < $1.uuidString },
                    clearsAllBefore: false,
                    deletedAt: Date()
                )
            )
            return effective.count
        }
    }

    public func deleteAll() throws {
        try lock.withLock {
            try appendDeletion(
                AgentAIConversationDeletion(
                    deletedMessageIDs: [], clearsAllBefore: true, deletedAt: Date()
                )
            )
        }
    }

    /// Deletion records are exempt from the size limit.
    ///
    /// The limit exists to stop the history growing without bound. Applying it
    /// here would mean a full history is one that can never be cleared, which
    /// turns a safety limit into a trap.
    private func appendDeletion(_ deletion: AgentAIConversationDeletion) throws {
        var line = try encoder.encode(deletion)
        line.append(0x0A)
        let handle = try FileHandle(forWritingTo: fileURL)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: line)
        try handle.synchronize()
    }

    /// Read fresh every time, from the file system rather than from the URL.
    ///
    /// `URL.resourceValues(forKeys:)` caches: once a size has been read for a
    /// `URL` value it returns that same number however far the file has since
    /// grown. This store holds one `URL` for its lifetime, so using it meant
    /// the 20 MB limit was only ever compared against the size the file had
    /// when the Agent started -- measured 2026-08-28: 3 bytes reported after
    /// the file had reached 5,003.
    private func currentFileSize() -> Int {
        let attributes = try? FileManager.default.attributesOfItem(atPath: fileURL.path)
        return (attributes?[.size] as? NSNumber)?.intValue ?? 0
    }

    private enum Line {
        case message(AgentAIConversationMessage)
        case deletion(AgentAIConversationDeletion)
    }

    private func decodedLines() throws -> [Line] {
        let data = try Data(contentsOf: fileURL)
        return data.split(separator: 0x0A).compactMap { row in
            let row = Data(row)
            // Deletions are tried first: a message decoder that ignores
            // unknown keys would otherwise have to be trusted not to accept
            // one, and a deletion read as a message is a deletion that never
            // happens.
            if let deletion = try? decoder.decode(AgentAIConversationDeletion.self, from: row) {
                return .deletion(deletion)
            }
            if let message = try? decoder.decode(AgentAIConversationMessage.self, from: row) {
                return .message(message)
            }
            return nil
        }
    }

    /// Replays the file in order, so a message written after a "delete
    /// everything" survives it.
    private func applyDeletions(to lines: [Line]) throws -> [AgentAIConversationMessage] {
        var kept: [AgentAIConversationMessage] = []
        for line in lines {
            switch line {
            case .message(let message):
                kept.append(message)
            case .deletion(let deletion):
                if deletion.clearsAllBefore {
                    kept.removeAll()
                } else {
                    let removed = Set(deletion.deletedMessageIDs)
                    kept.removeAll { removed.contains($0.id) }
                }
            }
        }
        return kept
    }

    public func messages(limit: Int = 500) throws -> [AgentAIConversationMessage] {
        try lock.withLock {
            let rows = try applyDeletions(to: try decodedLines())
            return Array(rows.suffix(max(1, min(limit, 500))))
        }
    }
}

public enum AgentAIConversationStoreError: LocalizedError, Equatable {
    case historyFull

    public var errorDescription: String? {
        "AI conversation history reached its 20 MB safety limit"
    }
}
