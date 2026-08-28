import XCTest
@testable import EgressViewAgentCore

final class AgentAIConversationStoreTests: XCTestCase {
    /// Writing never overwrites what is already there, and a reopen sees all
    /// of it. Deletion is the one thing that removes a row, and only when the
    /// person asks -- see the deletion tests below.
    func testAppendingNeverOverwritesAndHistorySurvivesReopen() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = directory.appendingPathComponent("history.jsonl")
        let conversation = UUID()
        let request = UUID()
        let date = Date(timeIntervalSince1970: 1_000)
        let first = AgentAIConversationMessage(
            conversationID: conversation, requestID: request, role: .user,
            body: "question", createdAt: date, model: "qwen3"
        )
        let second = AgentAIConversationMessage(
            conversationID: conversation, requestID: request, role: .assistant,
            body: "answer", createdAt: date, model: "qwen3", inputTokens: 10, outputTokens: 2
        )
        let store = try AgentAIConversationStore(fileURL: url)
        try store.append(first)
        try store.append(second)
        XCTAssertEqual(try AgentAIConversationStore(fileURL: url).messages(), [first, second])
        XCTAssertEqual((try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue, 0o600)
    }

    func testMalformedLineDoesNotHideLaterValidHistory() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let url = directory.appendingPathComponent("history.jsonl")
        let store = try AgentAIConversationStore(fileURL: url)
        try Data("not json\n".utf8).write(to: url)
        let message = AgentAIConversationMessage(
            conversationID: UUID(), requestID: UUID(), role: .assistant,
            body: "survives", createdAt: Date(timeIntervalSince1970: 1_000), model: "qwen3"
        )
        try store.append(message)
        XCTAssertEqual(try store.messages(), [message])
    }

    /// A deleted answer stops being returned, and the file was only appended to.
    ///
    /// The flag is the contract here: the line stays, so this checks what
    /// `messages()` returns and that nothing already written was rewritten.
    func testDeletingOneMessageHidesItAndOnlyAppends() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        let conversation = UUID()
        let question = message(conversation, .user, "what changed")
        let answer = message(conversation, .assistant, "an answer")
        try store.append(question)
        try store.append(answer)
        let beforeSize = try Data(contentsOf: url).count

        XCTAssertEqual(try store.delete(ids: [answer.id]), 1)

        XCTAssertEqual(try store.messages(), [question])
        XCTAssertEqual(try AgentAIConversationStore(fileURL: url).messages(), [question])
        // Appended, never rewritten: the file only grew.
        XCTAssertGreaterThan(try Data(contentsOf: url).count, beforeSize)
        XCTAssertEqual(permissions(url), 0o600)
    }

    func testDeletingEverythingHidesEveryConversation() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        try store.append(message(UUID(), .user, "one"))
        try store.append(message(UUID(), .assistant, "two"))

        try store.deleteAll()

        XCTAssertEqual(try store.messages(), [])
        XCTAssertEqual(try AgentAIConversationStore(fileURL: url).messages(), [])
    }

    /// A message written after "delete everything" survives it.
    ///
    /// The clear applies to what was written before it, not to the file. If it
    /// were applied on read without regard to order, the next answer would
    /// vanish the moment it arrived.
    func testAMessageWrittenAfterAClearSurvives() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        try store.append(message(UUID(), .user, "before"))
        try store.deleteAll()
        let later = message(UUID(), .user, "after")
        try store.append(later)

        XCTAssertEqual(try store.messages(), [later])
        XCTAssertEqual(try AgentAIConversationStore(fileURL: url).messages(), [later])
    }

    /// Deletion covers rows older than the window `messages()` returns.
    ///
    /// `messages(limit:)` hands back the last 500. A clear that only knew
    /// about those would leave older rows to reappear as newer ones are
    /// deleted.
    func testDeleteAllReachesRowsOlderThanTheReadWindow() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        for index in 0..<520 {
            try store.append(message(UUID(), .user, "row \(index)"))
        }
        XCTAssertEqual(try store.messages().count, 500)

        try store.deleteAll()

        XCTAssertEqual(try store.messages(), [])
    }

    /// A full history can still be cleared.
    ///
    /// The 20 MB limit exists to stop the file growing without bound. If it
    /// applied to deletions too, reaching it would mean the conversation can
    /// never be deleted -- a safety limit turned into a trap.
    ///
    /// The store is opened after the file is already oversized, because a
    /// store that has already appended once reports a stale size. See
    /// `testTheSizeLimitReadsTheSizeItHasAlreadyRead`.
    func testAHistoryAtTheSizeLimitCanStillBeCleared() throws {
        let url = temporaryURL()
        _ = try AgentAIConversationStore(fileURL: url)
        var padded = Data()
        padded.append(Data(repeating: 0x41, count: AgentAIConversationStore.maximumFileBytes))
        padded.append(0x0A)
        try padded.write(to: url)

        let store = try AgentAIConversationStore(fileURL: url)
        XCTAssertThrowsError(try store.append(message(UUID(), .user, "rejected")))

        try store.deleteAll()

        XCTAssertEqual(try store.messages(), [])
    }

    /// The size limit is measured against the file as it is now.
    ///
    /// It used to be measured against `URL.resourceValues`, which caches: once
    /// a size had been read for the store's `URL`, later appends compared
    /// against that same number however far the file had grown. The limit only
    /// held until the first append after launch.
    func testTheSizeLimitSeesGrowthSinceTheFirstAppend() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        try store.append(message(UUID(), .user, "first, which used to cache the size"))
        var padded = try Data(contentsOf: url)
        padded.append(Data(repeating: 0x41, count: AgentAIConversationStore.maximumFileBytes))
        padded.append(0x0A)
        try padded.write(to: url)

        XCTAssertThrowsError(try store.append(message(UUID(), .user, "past the limit"))) { error in
            XCTAssertEqual(error as? AgentAIConversationStoreError, .historyFull)
        }
        // The same store can still clear it -- the limit is not a trap.
        try store.deleteAll()
        XCTAssertEqual(try store.messages(), [])
    }

    func testDeletingNothingChangesNothing() throws {
        let url = temporaryURL()
        let store = try AgentAIConversationStore(fileURL: url)
        let kept = message(UUID(), .user, "kept")
        try store.append(kept)
        XCTAssertEqual(try store.delete(ids: []), 0)
        XCTAssertEqual(try store.delete(ids: [UUID()]), 0)
        XCTAssertEqual(try store.messages(), [kept])
    }

    private func temporaryURL() -> URL {
        FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathComponent("history.jsonl")
    }

    private func message(
        _ conversation: UUID, _ role: AgentAIMessageRole, _ body: String
    ) -> AgentAIConversationMessage {
        AgentAIConversationMessage(
            conversationID: conversation, requestID: UUID(), role: role,
            body: body, createdAt: Date(timeIntervalSince1970: 1_000), model: "qwen3"
        )
    }

    private func permissions(_ url: URL) -> Int? {
        (try? FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)??.intValue
    }
}
