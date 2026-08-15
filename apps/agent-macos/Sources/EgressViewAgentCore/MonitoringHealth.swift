import Foundation

/// One installed copy of the network monitoring System Extension, as macOS
/// reports it.
///
/// More than one can exist at a time: replacing an extension leaves the old
/// copy in place until the next restart.
public struct SystemExtensionVersion: Equatable, Sendable {
    public let shortVersion: String
    public let bundleVersion: String
    public let isEnabled: Bool
    public let isAwaitingUserApproval: Bool
    public let isUninstalling: Bool

    public init(
        shortVersion: String,
        bundleVersion: String,
        isEnabled: Bool,
        isAwaitingUserApproval: Bool = false,
        isUninstalling: Bool = false
    ) {
        self.shortVersion = shortVersion
        self.bundleVersion = bundleVersion
        self.isEnabled = isEnabled
        self.isAwaitingUserApproval = isAwaitingUserApproval
        self.isUninstalling = isUninstalling
    }
}

/// Whether monitoring is actually running, as opposed to merely installed.
public enum MonitoringHealth: Equatable, Sendable {
    case healthy
    case notInstalled
    case awaitingApproval
    /// The update is installed but is not the copy macOS is running, so nothing
    /// is being collected until the machine restarts.
    case rebootRequiredAfterUpdate(installed: String, running: String?)
}

/// Answers "is this Mac still being watched?" from what macOS reports about the
/// installed extensions.
///
/// This exists because the honest-looking signals lie. Replacing the extension
/// leaves the previous copy `terminated waiting to uninstall on reboot`, the
/// new copy reported as activated and enabled, and the XPC service answering
/// normally with zero observations -- so every check short of this one says
/// monitoring is fine while nothing at all is being recorded. That happened on
/// four consecutive updates, and the user was told "Network monitoring active"
/// each time.
public enum MonitoringHealthCheck {
    public static func evaluate(
        versions: [SystemExtensionVersion],
        appBundleVersion: String
    ) -> MonitoringHealth {
        guard !versions.isEmpty else { return .notInstalled }

        if versions.contains(where: \.isAwaitingUserApproval) {
            return .awaitingApproval
        }

        let running = versions.first { $0.isEnabled && !$0.isUninstalling }

        // A copy on its way out means the swap has not taken effect yet. This
        // is the state that produced silent data loss, and it is reported
        // whatever else looks healthy.
        if versions.contains(where: \.isUninstalling) {
            return .rebootRequiredAfterUpdate(
                installed: appBundleVersion, running: running?.bundleVersion
            )
        }

        guard let running else {
            return .rebootRequiredAfterUpdate(installed: appBundleVersion, running: nil)
        }

        // The app and its extension ship together, so a mismatch means macOS is
        // running an extension this app did not bring.
        if running.bundleVersion != appBundleVersion {
            return .rebootRequiredAfterUpdate(
                installed: appBundleVersion, running: running.bundleVersion
            )
        }

        return .healthy
    }
}
