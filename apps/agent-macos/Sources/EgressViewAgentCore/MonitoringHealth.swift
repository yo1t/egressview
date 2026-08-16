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
    /// How long the record may stay empty before a pending swap is treated as
    /// the reason.
    ///
    /// Measured on the real machine: an update sometimes takes effect
    /// immediately and sometimes not until a restart, with identical
    /// `systemextensionsctl` output either way. So the pending swap alone
    /// cannot be the trigger -- it produced a "nothing is being recorded"
    /// warning while 342 connections were recorded in three minutes.
    public static let silenceThreshold: TimeInterval = 180

    public static func evaluate(
        versions: [SystemExtensionVersion],
        appBundleVersion: String,
        lastObservationAt: Date? = nil,
        now: Date = Date()
    ) -> MonitoringHealth {
        guard !versions.isEmpty else { return .notInstalled }

        if versions.contains(where: \.isAwaitingUserApproval) {
            return .awaitingApproval
        }

        let running = versions.first { $0.isEnabled && !$0.isUninstalling }
        let swapPending = versions.contains(where: \.isUninstalling)
            || running == nil
            || running?.bundleVersion != appBundleVersion

        guard swapPending else { return .healthy }

        // A pending swap is only a problem if it actually stopped the
        // recording. Warning on the pending state alone cries wolf on every
        // update that worked, and a warning the user learns to ignore is worth
        // less than none -- this one has to be believed the time it is true.
        let silent = lastObservationAt.map { now.timeIntervalSince($0) >= silenceThreshold } ?? true
        guard silent else { return .healthy }

        return .rebootRequiredAfterUpdate(
            installed: appBundleVersion, running: running?.bundleVersion
        )
    }
}
