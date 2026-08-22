import Foundation

/// Switches that exist so the agent's own alarms can be rehearsed.
///
/// Not developer leftovers. The state these rehearse -- "nothing is being
/// recorded" -- is the one the user most needs to be told about, and it is the
/// hardest to produce on purpose: it means stopping collection and waiting half
/// an hour, which costs the user exactly the record the alarm exists to protect.
///
/// So that path went untested. It was untested on 2026-08-18 when this Mac
/// recorded nothing for thirteen and a half hours: the alarm never fired, and
/// the agent had no entry in Notification Center at all, because
/// `requestAuthorization` had never once been called.
///
/// Nothing here can hide an outage. The forced state is the alarm, not the
/// silence -- setting it makes the agent claim it has stopped recording when it
/// has not. It errs toward warning, never toward reassurance.
enum AgentDiagnostics {
    /// Makes the health check behave as though nothing has been recorded for a
    /// long time, so the notification and the menu bar can be seen firing.
    ///
    /// ```sh
    /// defaults write com.egressview.agent.macos diagnosticsForceNotRecording -bool YES
    /// ```
    ///
    /// The agent consumes and removes this trigger when the next health check
    /// begins. Monitoring itself is untouched: collection continues, and the
    /// record stays complete. Set it again to run another rehearsal.
    static let forceNotRecordingKey = "diagnosticsForceNotRecording"

    static func consumeForceNotRecording() -> Bool {
        let defaults = UserDefaults.standard
        guard defaults.bool(forKey: forceNotRecordingKey) else { return false }
        defaults.removeObject(forKey: forceNotRecordingKey)
        return true
    }
}
