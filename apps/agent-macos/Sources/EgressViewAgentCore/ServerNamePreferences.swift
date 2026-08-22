import Foundation

/// Whether the agent may read the destination name out of the TLS handshake.
///
/// **Off unless the user turns it on**. The Host persists this preference and
/// sends its value to the network extension over the authenticated XPC channel.
///
/// The distinction this setting draws is not "read nothing" versus "read
/// everything". What it allows is the first message of a TLS handshake, in
/// which the client states where it is going before there is any key -- the
/// same name the operating system already hands over for applications that use
/// its networking. Nothing is decrypted, and nothing after that first message
/// is looked at.
public struct ServerNamePreferences {
    public static let enabledKey = "readsServerNameFromHandshake"

    private let defaults: UserDefaults

    public init() {
        defaults = UserDefaults(suiteName: ObservationJournal.appGroupIdentifier) ?? .standard
    }

    public init(defaults: UserDefaults) {
        self.defaults = defaults
    }

    public var isEnabled: Bool {
        get { defaults.bool(forKey: Self.enabledKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.enabledKey) }
    }
}
