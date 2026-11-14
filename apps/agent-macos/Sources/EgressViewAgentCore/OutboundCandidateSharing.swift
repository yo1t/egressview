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

    public static let entryLimit = AgentLocalInsightCandidateList.entryLimit

    /// The list as it stands, with notes only when `includesNotes`.
    public init(
        report: OutboundCandidateReport,
        judgments: [String: OutboundCandidateJudgment],
        includesNotes: Bool,
        generatedAt: Date = Date()
    ) {
        schemaVersion = 1
        sharing = true
        self.generatedAt = generatedAt
        switch report.state {
        case .learning: state = "learning"
        case .lowByteCoverage: state = "lowByteCoverage"
        case .ready: state = "ready"
        }
        total = report.total
        let limit = AgentLocalInsightBuilder.nameCharacterLimit
        entries = report.candidates.prefix(Self.entryLimit).map { candidate in
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
            state: state, total: total, entries: entries
        )
        return SHA256.hash(data: try stable.encoded()).map { String(format: "%02x", $0) }.joined()
    }

    private init(
        schemaVersion: Int, sharing: Bool, generatedAt: Date, state: String?, total: Int, entries: [Entry]
    ) {
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
}
