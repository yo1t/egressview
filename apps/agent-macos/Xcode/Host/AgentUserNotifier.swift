import Foundation
import UserNotifications

/// Tells the user something they need to act on, even when the app's windows
/// are closed.
///
/// Used sparingly, and only for states where the agent is not doing the one job
/// it was installed for. A notification the user learns to dismiss is worse
/// than none, because the next one gets dismissed too.
final class AgentUserNotifier {
    static let shared = AgentUserNotifier()

    private init() {}

    /// Posts a notification, and reports whether it will actually be seen.
    ///
    /// The result matters. On 2026-08-18 this Mac stopped recording for
    /// thirteen and a half hours and nothing was ever shown -- and the agent
    /// had no entry in Notification Center at all, so not one of these calls
    /// had reached macOS. A caller that assumes the message got through will
    /// stop looking for another way to say it, which is how that outage stayed
    /// invisible.
    func notify(title: String, body: String, completion: ((Bool) -> Void)? = nil) {
        let center = UNUserNotificationCenter.current()
        // Asked for at the moment there is something worth saying, not at
        // launch: a prompt with no reason attached gets refused, and this is
        // the one message that must get through.
        //
        // `getNotificationSettings` first, because `requestAuthorization` on an
        // app the user already refused returns `false` without showing
        // anything, and the two cases need to be told apart: one is worth
        // retrying, the other never will be.
        center.getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional:
                Self.post(title: title, body: body, to: center)
                completion?(true)
            case .denied:
                // Refused once and for all. Saying it again here would do
                // nothing; the menu bar is what carries the state from now on.
                completion?(false)
            case .notDetermined:
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    if granted {
                        Self.post(title: title, body: body, to: center)
                    }
                    completion?(granted)
                }
            @unknown default:
                completion?(false)
            }
        }
    }

    private static func post(
        title: String, body: String, to center: UNUserNotificationCenter
    ) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(
            identifier: UUID().uuidString, content: content, trigger: nil
        )
        center.add(request)
    }
}
