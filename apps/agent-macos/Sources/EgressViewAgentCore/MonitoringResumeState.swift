import Foundation

/// What monitoring was doing when the agent was told to quit.
///
/// Quitting stops monitoring on purpose: an agent that is not running has no
/// business leaving a filter inspecting traffic with nothing on screen to show
/// for it. But stopping is not the same as being asked to stop, and until
/// 2026-09-13 the agent could not tell the two apart. It read the filter's
/// state at launch and took that as the wish, so quitting looked exactly like
/// the Pause menu item: monitoring stayed off, and nobody had chosen that
/// (P3-121).
///
/// So the agent writes down what it was doing before it stops itself, and
/// resumes only that. Pause writes nothing, and stays paused. Nothing else
/// writes anything -- in particular, someone who turns the extension off in
/// System Settings (which is how uninstalling starts) leaves no note here, and
/// is not asked to approve it again at the next login.
public struct MonitoringResumeState: Sendable {
    public static let key = "monitoringModeBeforeQuit"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    /// The mode to put back, if the agent is the one that stopped it.
    public var modeBeforeQuit: String? {
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

    /// Reads the note and tears it up.
    ///
    /// Taken once: a resume that failed must not be retried at every login
    /// forever, and a note left behind would be indistinguishable from a wish.
    public func takeModeBeforeQuit() -> String? {
        let mode = modeBeforeQuit
        modeBeforeQuit = nil
        return mode
    }
}
