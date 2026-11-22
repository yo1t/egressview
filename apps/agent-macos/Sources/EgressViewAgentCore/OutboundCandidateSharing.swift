import CryptoKit
import Foundation

/// Whether the person sends the "worth a look" list and their answers to the
/// Hub (P3-194). Both off by default: a list of what stood out, and above all
/// a note, is about the person at this Mac, and the Hub is often run by
/// someone else.
public struct OutboundCandidateSharingPreferences: @unchecked Sendable {
    public static let enabledKey = "outboundCandidateSharingEnabled"
    public static let includesNotesKey = "outboundCandidateSharingIncludesNotes"
    static let lastSentHashKey = "outboundCandidateSharingLastHash"
    static let lastSentAtKey = "outboundCandidateSharingLastSentAt"
    static let hubMayHoldListKey = "outboundCandidateSharingHubMayHoldList"
    static let hubTakesAnswersKey = "outboundCandidateSharingHubTakesAnswers"
    static let appliedAnswersVersionKey = "outboundCandidateSharingAppliedAnswersVersion"
    static let hubHasNotesSharedKey = "outboundCandidateSharingHubHasNotesShared"
    static let hubMaximumEntriesKey = "outboundCandidateSharingHubMaximumEntries"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }

    /// Only read while `isEnabled` is on.
    public var includesNotes: Bool {
        get { defaults.bool(forKey: Self.includesNotesKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.includesNotesKey) }
    }

    public var lastSentHash: String? {
        get { defaults.string(forKey: Self.lastSentHashKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.lastSentHashKey) }
    }

    public var lastSentAt: Date? {
        get { defaults.object(forKey: Self.lastSentAtKey) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Self.lastSentAtKey) }
    }

    /// Set once a list has reached the Hub, cleared once the Hub has been told
    /// to delete it. While set and sharing is off, the delete is still owed.
    public var hubMayHoldList: Bool {
        get { defaults.bool(forKey: Self.hubMayHoldListKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.hubMayHoldListKey) }
    }

    /// Whether the Hub answers candidates itself (P3-194 stage 2): learned
    /// from its delivery replies, which then carry `outboundAnswersVersion`.
    /// Only such a Hub is told `notesShared`; an older one refuses a field
    /// it does not know.
    public var hubTakesAnswers: Bool {
        get { defaults.bool(forKey: Self.hubTakesAnswersKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.hubTakesAnswersKey) }
    }

    /// Whether the last list the Hub took said `notesShared: true`. Until it
    /// has, the Hub sends no notes, and an answer without one must not wipe
    /// the note here.
    public var hubHasNotesShared: Bool {
        get { defaults.bool(forKey: Self.hubHasNotesSharedKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.hubHasNotesSharedKey) }
    }

    /// How many candidates the Hub takes in one list, as its capabilities
    /// last said. Nil until asked, or when the Hub does not say; it then
    /// takes 20 (`OutboundCandidateSharePayload.legacyEntryLimit`).
    public var hubMaximumEntries: Int? {
        get { defaults.object(forKey: Self.hubMaximumEntriesKey) as? Int }
        nonmutating set { defaults.set(newValue, forKey: Self.hubMaximumEntriesKey) }
    }

    /// The Hub's answer version last taken in.
    public var appliedAnswersVersion: Int? {
        get { defaults.object(forKey: Self.appliedAnswersVersionKey) as? Int }
        nonmutating set { defaults.set(newValue, forKey: Self.appliedAnswersVersionKey) }
    }
}

/// What goes to `PUT /api/agent/outbound-candidates`.
///
/// The same entries the AI context carries, with two differences: the
/// candidate is named by a hash of its ID, which is all the Hub needs to keep
/// rows apart, and a note goes only when the person turned on the second
/// switch.
public struct OutboundCandidateSharePayload: Encodable, Equatable, Sendable {
    public struct Entry: Encodable, Equatable, Sendable {
        public let candidateId: String
        public let kind: String
        public let day: Date
        public let application: String?
        public let destination: String?
        public let bytesOut: UInt64
        public let usualBytesOut: UInt64?
        public let answer: String?
        public let answeredAt: Date?
        public let note: String?
    }

    public let schemaVersion: Int
    public let sharing: Bool
    public let generatedAt: Date
    public let state: String?
    public let total: Int
    public let entries: [Entry]
    /// Whether notes travel between this Mac and the Hub. Left out (nil) for
    /// a Hub that does not answer candidates, which would refuse it.
    public let notesShared: Bool?

    /// What every Hub takes, and all a Hub that does not name
    /// `maxOutboundCandidates` in its capabilities takes: it refuses a
    /// longer list whole.
    public static let legacyEntryLimit = 20
    /// The most this Mac sends even to a Hub that would take more, which
    /// keeps the body under the Hub's 512 KiB with the longest names and
    /// notes. A Mac watched in 2026-11 listed 27 at the most.
    public static let maximumEntryLimit = 150

    /// How many to send to a Hub that said it takes `hubMaximum`.
    public static func entryLimit(hubMaximum: Int?) -> Int {
        guard let hubMaximum, hubMaximum > legacyEntryLimit else { return legacyEntryLimit }
        return min(hubMaximum, maximumEntryLimit)
    }

    /// The list as it stands, with notes only when `includesNotes`, cut at
    /// `entryLimit` (`total` still counts them all).
    public init(
        report: OutboundCandidateReport,
        judgments: [String: OutboundCandidateJudgment],
        includesNotes: Bool,
        hubTakesAnswers: Bool = false,
        entryLimit: Int = Self.legacyEntryLimit,
        generatedAt: Date = Date()
    ) {
        schemaVersion = 1
        sharing = true
        notesShared = hubTakesAnswers ? includesNotes : nil
        self.generatedAt = generatedAt
        switch report.state {
        case .learning: state = "learning"
        case .lowByteCoverage: state = "lowByteCoverage"
        case .ready: state = "ready"
        }
        total = report.total
        let limit = AgentLocalInsightBuilder.nameCharacterLimit
        entries = report.candidates.prefix(max(0, entryLimit)).map { candidate in
            let judgment = judgments[candidate.id]
            let note = includesNotes
                ? (judgment?.note.trimmingCharacters(in: .whitespacesAndNewlines) ?? "")
                : ""
            return Entry(
                candidateId: Self.hashedID(candidate.id),
                kind: candidate.kind.rawValue, day: candidate.at,
                application: candidate.application.map { Self.clipped($0, to: limit) },
                destination: candidate.destination.map { Self.clipped($0, to: limit) },
                bytesOut: candidate.bytesOut, usualBytesOut: candidate.usualBytesOut,
                answer: judgment?.verdict.rawValue,
                answeredAt: judgment?.judgedAt,
                note: judgment == nil || note.isEmpty
                    ? nil : Self.clipped(note, to: ObservationStore.judgmentNoteLimit)
            )
        }
    }

    private init(off generatedAt: Date) {
        schemaVersion = 1
        sharing = false
        notesShared = nil
        self.generatedAt = generatedAt
        state = nil
        total = 0
        entries = []
    }

    /// Tells the Hub to delete what it holds for this Mac.
    public static func off(generatedAt: Date = Date()) -> OutboundCandidateSharePayload {
        OutboundCandidateSharePayload(off: generatedAt)
    }

    /// The Hub counts length in UTF-16 units, as JavaScript does, so an emoji
    /// counts twice there. Cut on a whole character within that count.
    static func clipped(_ text: String, to limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var result = ""
        var used = 0
        for character in text {
            let size = character.utf16.count
            if used + size > limit { break }
            result.append(character)
            used += size
        }
        return result
    }

    static func hashedID(_ id: String) -> String {
        SHA256.hash(data: Data(id.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(self)
    }

    /// Changes when anything the Hub would show changes; not when only the
    /// time of sending does.
    public func contentHash() throws -> String {
        let stable = OutboundCandidateSharePayload(
            schemaVersion: schemaVersion, sharing: sharing, generatedAt: Date(timeIntervalSince1970: 0),
            state: state, total: total, entries: entries, notesShared: notesShared
        )
        return SHA256.hash(data: try stable.encoded()).map { String(format: "%02x", $0) }.joined()
    }

    private init(
        schemaVersion: Int, sharing: Bool, generatedAt: Date, state: String?, total: Int, entries: [Entry],
        notesShared: Bool?
    ) {
        self.notesShared = notesShared
        self.schemaVersion = schemaVersion
        self.sharing = sharing
        self.generatedAt = generatedAt
        self.state = state
        self.total = total
        self.entries = entries
    }
}

/// When to send. Kept apart from the timer and the network so it can be
/// tested on its own.
public enum OutboundCandidateSharePlan: Equatable, Sendable {
    case nothing
    case sendList
    case sendOff

    /// Sent again after this long even without a change, so the Hub's
    /// "received" time says the Mac is still sharing.
    public static let resendInterval: TimeInterval = 6 * 3600

    public static func decide(
        isEnabled: Bool, hubMayHoldList: Bool, lastSentHash: String?, lastSentAt: Date?,
        currentHash: String?, now: Date = Date()
    ) -> OutboundCandidateSharePlan {
        guard isEnabled else { return hubMayHoldList ? .sendOff : .nothing }
        guard let currentHash else { return .nothing }
        if currentHash != lastSentHash { return .sendList }
        guard let lastSentAt else { return .sendList }
        return now.timeIntervalSince(lastSentAt) >= resendInterval ? .sendList : .nothing
    }
}

public enum OutboundCandidateShareError: Error, Equatable {
    case insecureURL
    /// The Hub answered 404: it is older than this feature.
    case hubTooOld
    case httpStatus(Int)
    case transport(String)
}

/// Sends the list to the Hub this Mac is enrolled with. HTTPS only, as for
/// threat information, except to this Mac itself.
public struct OutboundCandidateUploader: Sendable {
    private let hubURL: URL
    private let token: String
    private let userAgent: String
    private let transport: any GeoCacheTransport

    public init(
        hubURL: URL, token: String, userAgent: String,
        transport: any GeoCacheTransport = URLSessionGeoCacheTransport(timeout: 60)
    ) {
        self.hubURL = hubURL
        self.token = token
        self.userAgent = userAgent
        self.transport = transport
    }

    public func send(_ payload: OutboundCandidateSharePayload) async throws {
        let url = hubURL.appendingPathComponent("api/agent/outbound-candidates")
        guard url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            throw OutboundCandidateShareError.insecureURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpShouldHandleCookies = false
        request.httpBody = try payload.encoded()

        let response: HTTPURLResponse
        do {
            (_, response) = try await transport.fetch(request)
        } catch {
            throw OutboundCandidateShareError.transport(error.localizedDescription)
        }
        switch response.statusCode {
        case 200: return
        case 404: throw OutboundCandidateShareError.hubTooOld
        default: throw OutboundCandidateShareError.httpStatus(response.statusCode)
        }
    }

    /// What the Hub's capabilities say about the list's length.
    public enum HubMaximum: Equatable, Sendable {
        /// The Hub named how many it takes.
        case says(Int)
        /// The Hub answered and did not say, or has no capabilities at all
        /// (404): it takes the legacy 20.
        case doesNotSay
        /// The Hub could not be asked; keep what it said before.
        case unknown
    }

    private struct Capabilities: Decodable {
        let maxOutboundCandidates: Int?
    }

    /// Asks `GET /api/agent/capabilities` how many candidates one list may
    /// hold. Sent only where the list itself would go.
    public func hubMaximum() async -> HubMaximum {
        let url = hubURL.appendingPathComponent("api/agent/capabilities")
        guard url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            return .unknown
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false
        guard let (data, response) = try? await transport.fetch(request) else { return .unknown }
        switch response.statusCode {
        case 200:
            guard let capabilities = try? JSONDecoder().decode(Capabilities.self, from: data) else {
                return .unknown
            }
            return capabilities.maxOutboundCandidates.map { .says($0) } ?? .doesNotSay
        case 404:
            return .doesNotSay
        default:
            return .unknown
        }
    }
}

/// One answer the Hub's administrator gave, as `GET
/// /api/agent/outbound-candidates/answers` lists it (P3-194 stage 2).
public struct OutboundCandidateHubAnswer: Decodable, Equatable, Sendable {
    /// The hash this Mac sent for the candidate.
    public let candidateId: String
    /// `expected`, `investigate`, or nil when the administrator took the
    /// answer back.
    public let answer: String?
    /// Only when this Mac shares notes.
    public let note: String?
    public let answeredAt: Date

    public init(candidateId: String, answer: String?, note: String?, answeredAt: Date) {
        self.candidateId = candidateId
        self.answer = answer
        self.note = note
        self.answeredAt = answeredAt
    }
}

public struct OutboundCandidateHubAnswers: Decodable, Equatable, Sendable {
    public let version: Int
    public let answers: [OutboundCandidateHubAnswer]

    /// The Hub writes times as JavaScript does, with milliseconds.
    public static func decode(_ data: Data) throws -> OutboundCandidateHubAnswers {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let text = try decoder.singleValueContainer().decode(String.self)
            let precise = ISO8601DateFormatter()
            precise.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let date = precise.date(from: text) ?? ISO8601DateFormatter().date(from: text) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath, debugDescription: "not an ISO 8601 time"
            ))
        }
        return try decoder.decode(OutboundCandidateHubAnswers.self, from: data)
    }
}

/// Asks the Hub for the answers its administrator gave. HTTPS only, as for
/// sending the list.
public struct OutboundCandidateAnswersFetcher: Sendable {
    private let hubURL: URL
    private let token: String
    private let userAgent: String
    private let transport: any GeoCacheTransport

    public init(
        hubURL: URL, token: String, userAgent: String,
        transport: any GeoCacheTransport = URLSessionGeoCacheTransport(timeout: 60)
    ) {
        self.hubURL = hubURL
        self.token = token
        self.userAgent = userAgent
        self.transport = transport
    }

    public func fetch() async throws -> OutboundCandidateHubAnswers {
        let url = hubURL.appendingPathComponent("api/agent/outbound-candidates/answers")
        guard url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            throw OutboundCandidateShareError.insecureURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpShouldHandleCookies = false

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.fetch(request)
        } catch {
            throw OutboundCandidateShareError.transport(error.localizedDescription)
        }
        switch response.statusCode {
        case 200: return try OutboundCandidateHubAnswers.decode(data)
        case 404: throw OutboundCandidateShareError.hubTooOld
        default: throw OutboundCandidateShareError.httpStatus(response.statusCode)
        }
    }
}
