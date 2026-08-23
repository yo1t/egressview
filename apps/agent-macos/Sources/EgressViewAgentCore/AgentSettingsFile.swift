import Foundation

/// The settings a person can carry to another machine, as a file they can read.
///
/// Deliberately not a backup of everything. Three kinds of setting are left
/// out on purpose:
///
/// - **Secrets.** The Hub credential lives in the Keychain and is never written
///   out: a settings file that carries one turns "copy my preferences" into
///   "copy my access". The enrolled Hub address is left out with it, because it
///   is held alongside that credential and enrolling is a deliberate act.
/// - **System-level changes.** Launching at login is a registration with macOS,
///   and importing a file must not quietly make one.
/// - **Anything that would start talking to a third party.** Turning on
///   third-party geo lookup is the one setting that would send the destinations
///   this agent watches to somebody else. A file must not be able to do that on
///   someone's behalf.
///
/// Every field is optional so a file written by another version -- or by the
/// Windows agent, which will not have all of these -- still applies what it
/// does carry instead of failing as a whole.
public struct AgentSettingsFile: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var retentionDays: Int?
    public var hubDeliveryEnabled: Bool?
    public var readServerNameFromHandshake: Bool?
    public var automaticUpdateChecks: Bool?
    public var language: String?

    public init(
        version: Int = AgentSettingsFile.currentVersion,
        retentionDays: Int? = nil,
        hubDeliveryEnabled: Bool? = nil,
        readServerNameFromHandshake: Bool? = nil,
        automaticUpdateChecks: Bool? = nil,
        language: String? = nil
    ) {
        self.version = version
        self.retentionDays = retentionDays
        self.hubDeliveryEnabled = hubDeliveryEnabled
        self.readServerNameFromHandshake = readServerNameFromHandshake
        self.automaticUpdateChecks = automaticUpdateChecks
        self.language = language
    }

    /// Names the file is allowed to carry, so that a value which is neither
    /// applied nor named as ignored cannot exist.
    public enum Field: String, CaseIterable, Sendable {
        case retentionDays
        case hubDeliveryEnabled
        case readServerNameFromHandshake
        case automaticUpdateChecks
        case language
    }

    public static let allowedLanguages = ["system", "english", "japanese"]

    /// What a file is worth applying, and what it is not.
    ///
    /// A value that cannot be honoured is dropped and reported rather than
    /// clamped to something nearby: a machine told to keep 45 days of history
    /// must not silently end up keeping 30 and reporting success.
    public func validated() -> (settings: AgentSettingsFile, ignored: [Field]) {
        var result = AgentSettingsFile(version: Self.currentVersion)
        var ignored: [Field] = []

        if let days = retentionDays {
            if ObservationRetention.allowedRetentionDays.contains(days) {
                result.retentionDays = days
            } else {
                ignored.append(.retentionDays)
            }
        }
        if let language {
            if Self.allowedLanguages.contains(language) {
                result.language = language
            } else {
                ignored.append(.language)
            }
        }
        result.hubDeliveryEnabled = hubDeliveryEnabled
        result.readServerNameFromHandshake = readServerNameFromHandshake
        result.automaticUpdateChecks = automaticUpdateChecks
        return (result, ignored)
    }

    /// Which fields this file actually carries, in a fixed order, so the import
    /// can tell the user what changed rather than "settings imported".
    public var presentFields: [Field] {
        Field.allCases.filter { field in
            switch field {
            case .retentionDays: return retentionDays != nil
            case .hubDeliveryEnabled: return hubDeliveryEnabled != nil
            case .readServerNameFromHandshake: return readServerNameFromHandshake != nil
            case .automaticUpdateChecks: return automaticUpdateChecks != nil
            case .language: return language != nil
            }
        }
    }

    /// Readable on purpose: the point of the file is that its owner can open it
    /// and see there is nothing in it they would not hand to someone else.
    public func encoded() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    /// Unknown keys are ignored rather than rejected. A file from a later
    /// version, or from another platform, should still be usable for the
    /// settings both versions share.
    public static func decode(_ data: Data) throws -> AgentSettingsFile {
        try JSONDecoder().decode(AgentSettingsFile.self, from: data)
    }

    public static func suggestedFileName(now: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return "egressview-agent-settings-\(formatter.string(from: now)).json"
    }
}
