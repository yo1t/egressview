import Foundation

/// Whether the agent looks for updates, and when it last did.
///
/// This is the one outbound request the agent makes on its own behalf, so the
/// default is deliberate: ON. Everything that sends observation data defaults
/// to OFF, but an update check sends a version string and no identifier, and a
/// default of OFF would mean nobody ever learns that a fix exists.
///
/// The user is told at first launch and can turn it off, and the settings
/// screen must say what turning it off costs: updates then have to be found by
/// hand.
public struct AgentUpdatePreferences: @unchecked Sendable {
    public static let enabledKey = "updateCheckEnabled"
    public static let lastCheckKey = "updateCheckLastCompletedAt"
    public static let lastAttemptKey = "updateCheckLastAttemptedAt"

    /// Once a day. Often enough that a fix reaches people, rare enough that the
    /// request log cannot describe someone's working hours.
    public static let checkInterval: TimeInterval = 24 * 60 * 60

    /// After a failure, try again sooner than a full day but not on every
    /// launch. A dropped connection should not cost a day of updates, and a
    /// host that is down should not be hammered.
    public static let retryInterval: TimeInterval = 60 * 60

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [Self.enabledKey: true])
    }

    public var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }

    public var lastCheckedAt: Date? {
        get { defaults.object(forKey: Self.lastCheckKey) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Self.lastCheckKey) }
    }

    public var lastAttemptedAt: Date? {
        get { defaults.object(forKey: Self.lastAttemptKey) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Self.lastAttemptKey) }
    }

    /// `offline` is passed in rather than read here: it is a whole-agent mode,
    /// not an update setting, and an agent told to stay offline must not make
    /// this request regardless of what this preference says.
    public func shouldCheck(now: Date, offline: Bool = false) -> Bool {
        guard isEnabled, !offline else { return false }
        guard elapsed(since: lastCheckedAt, now: now) >= Self.checkInterval else { return false }
        return elapsed(since: lastAttemptedAt, now: now) >= Self.retryInterval
    }

    /// A clock that moved backwards would otherwise suppress checks until it
    /// caught up, so a future timestamp counts as "long ago".
    private func elapsed(since date: Date?, now: Date) -> TimeInterval {
        guard let date, date <= now else { return .greatestFiniteMagnitude }
        return now.timeIntervalSince(date)
    }
}
