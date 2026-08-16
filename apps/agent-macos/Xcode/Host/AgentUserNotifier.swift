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

    func notify(title: String, body: String) {
        let center = UNUserNotificationCenter.current()
        // Permission is asked for at the moment there is something worth
        // saying, not at launch: a prompt with no reason attached gets
        // refused, and this is the one message that must get through.
        center.requestAuthorization(options: [.alert]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body
            let request = UNNotificationRequest(
                identifier: UUID().uuidString, content: content, trigger: nil
            )
            center.add(request)
        }
    }
}
