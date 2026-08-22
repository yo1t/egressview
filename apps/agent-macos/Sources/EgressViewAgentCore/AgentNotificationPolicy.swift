import Foundation

public enum AgentNotificationKind: String, CaseIterable, Codable, Sendable {
    case threat
    case monitoring
    case hubDelivery
    case threatIntelChange
    case recovery
}

public enum AgentNotificationDailyLimit: Int, CaseIterable, Codable, Sendable {
    case five = 5
    case twelve = 12
    case twentyFive = 25
    /// Zero means that only the per-event cooldown limits delivery.
    case unlimited = 0

    public static let defaultValue = AgentNotificationDailyLimit.twelve
}

public struct AgentNotificationLimiterState: Codable, Equatable, Sendable {
    public var dayStartedAt: Date
    public var sentToday: Int
    public var suppressedToday: Int
    public var lastSentByKey: [String: Date]

    public init(
        dayStartedAt: Date = Date(timeIntervalSince1970: 0),
        sentToday: Int = 0,
        suppressedToday: Int = 0,
        lastSentByKey: [String: Date] = [:]
    ) {
        self.dayStartedAt = dayStartedAt
        self.sentToday = sentToday
        self.suppressedToday = suppressedToday
        self.lastSentByKey = lastSentByKey
    }

    private enum CodingKeys: String, CodingKey {
        case dayStartedAt, sentToday, suppressedToday, lastSentByKey
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        dayStartedAt = try values.decode(Date.self, forKey: .dayStartedAt)
        sentToday = try values.decode(Int.self, forKey: .sentToday)
        suppressedToday = try values.decodeIfPresent(Int.self, forKey: .suppressedToday) ?? 0
        lastSentByKey = try values.decode([String: Date].self, forKey: .lastSentByKey)
    }
}

/// Bounds local notifications before asking macOS to deliver them.
public struct AgentNotificationLimiter: Sendable {
    public static let defaultCooldown: TimeInterval = 60 * 60

    public private(set) var state: AgentNotificationLimiterState

    public init(state: AgentNotificationLimiterState = AgentNotificationLimiterState()) {
        self.state = state
    }

    public mutating func consume(
        key: String,
        now: Date = Date(),
        cooldown: TimeInterval = defaultCooldown,
        dailyLimit: AgentNotificationDailyLimit = .defaultValue
    ) -> Bool {
        if !Calendar.current.isDate(now, inSameDayAs: state.dayStartedAt)
            || now < state.dayStartedAt {
            state.dayStartedAt = now
            state.sentToday = 0
            state.suppressedToday = 0
        }
        if let last = state.lastSentByKey[key], now.timeIntervalSince(last) < cooldown {
            return false
        }
        if dailyLimit != .unlimited, state.sentToday >= dailyLimit.rawValue {
            state.suppressedToday += 1
            return false
        }
        state.sentToday += 1
        state.lastSentByKey[key] = now
        state.lastSentByKey = state.lastSentByKey.filter {
            now.timeIntervalSince($0.value) < 7 * 24 * 60 * 60
        }
        return true
    }
}
