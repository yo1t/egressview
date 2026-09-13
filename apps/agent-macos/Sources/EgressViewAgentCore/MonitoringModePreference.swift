import Foundation

/// What the user asked monitoring to do — the setting, not the state.
///
/// Until 2026-09-13 this had nowhere to live. The launch path asked macOS
/// whether the filter was enabled and took that answer as the wish, so
/// quitting — which takes the filter down on purpose — looked exactly like the
/// Pause the user never chose, and monitoring stayed off (P3-121).
///
/// The distinction the agent could not make: quitting is "not looking right
/// now", pausing is "not monitoring for a while". One is a state, the other is
/// a setting. This is the setting, and it is what the Settings window shows.
///
/// Written only when someone chooses a mode — from the menu bar, or from
/// Settings. Quitting does not touch it, which is exactly why the next launch
/// puts monitoring back.
public struct MonitoringModePreference: Sendable {
    public static let key = "monitoringMode"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The chosen mode, or nil when nobody has chosen yet.
    ///
    /// Nil is not "paused": on a first run, and on an upgrade from a version
    /// that never wrote this, the agent has to fall back to asking macOS what
    /// is actually running rather than inventing an answer.
    public var storedMode: String? {
        get {
            guard let value = defaults.string(forKey: Self.key), !value.isEmpty else { return nil }
            return value
        }
        nonmutating set {
            if let newValue, !newValue.isEmpty {
                defaults.set(newValue, forKey: Self.key)
            } else {
                defaults.removeObject(forKey: Self.key)
            }
        }
    }
}
