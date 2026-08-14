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

    /// Once a day. Often enough that a fix reaches people, rare enough that the
    /// request log cannot describe someone's working hours.
    public static let checkInterval: TimeInterval = 24 * 60 * 60

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

    /// `offline` is passed in rather than read here: it is a whole-agent mode,
    /// not an update setting, and an agent told to stay offline must not make
    /// this request regardless of what this preference says.
    public func shouldCheck(now: Date, offline: Bool = false) -> Bool {
        guard isEnabled, !offline else { return false }
        guard let last = lastCheckedAt else { return true }
        // A clock that moved backwards would otherwise suppress checks until it
        // caught up; treat a future timestamp as due.
        if last > now { return true }
        return now.timeIntervalSince(last) >= Self.checkInterval
    }
}
