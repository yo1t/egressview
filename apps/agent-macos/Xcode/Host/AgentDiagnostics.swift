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
    /// Unset it to go back to the real answer. Monitoring itself is untouched
    /// either way: collection continues, and the record stays complete.
    static let forceNotRecordingKey = "diagnosticsForceNotRecording"

    static var forcesNotRecording: Bool {
        UserDefaults.standard.bool(forKey: forceNotRecordingKey)
    }
}
