import Foundation

public struct AgentDeliveryPreferences: @unchecked Sendable {
    public static let enabledKey = "hubDeliveryEnabled"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        defaults.register(defaults: [Self.enabledKey: false])
    }

    public var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }
}
