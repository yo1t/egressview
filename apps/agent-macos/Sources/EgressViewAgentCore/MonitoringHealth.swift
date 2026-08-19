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
    /// Everything macOS reports looks correct, the Mac has been awake and in
    /// use, and still nothing is arriving.
    ///
    /// This is the state that cost a user thirteen and a half hours of record
    /// on 2026-08-18 with no warning of any kind: the extension versions
    /// matched, so no swap was pending, so the check below returned `healthy`
    /// for every one of the 800 times it ran during the outage.
    case silentWhileActive(since: Date?)
    /// macOS was asked whether the extension is running and did not answer.
    ///
    /// Not a verdict about monitoring -- it is the absence of one, and it is
    /// reported rather than swallowed. An unanswered question used to leave the
    /// check silent, which the rest of the app could only read as "fine".
    case unanswered
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

    /// How long a working Mac may record nothing before that is treated as a
    /// fault in its own right, with no pending update to blame.
    ///
    /// Deliberately much longer than `silenceThreshold`. That one is read only
    /// when a swap is already known to be pending, so it may be impatient. This
    /// one has nothing corroborating it and must not fire on a Mac that is
    /// merely quiet -- so it waits half an hour, and only counts time the
    /// machine was actually awake.
    public static let unexplainedSilenceThreshold: TimeInterval = 1800

    public static func evaluate(
        versions: [SystemExtensionVersion],
        appBundleVersion: String,
        lastObservationAt: Date? = nil,
        awakeSince: Date? = nil,
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

        guard swapPending else {
            return unexplainedSilence(
                lastObservationAt: lastObservationAt, awakeSince: awakeSince, now: now
            )
        }

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

    /// Evaluates silence when macOS does not answer the extension-properties
    /// request. Recent observations prove collection is working; prolonged
    /// silence must still be reported instead of hidden by the failed query.
    public static func evaluateSilenceWithoutExtensionState(
        lastObservationAt: Date?, monitoringSince: Date?, now: Date = Date()
    ) -> MonitoringHealth {
        unexplainedSilence(
            lastObservationAt: lastObservationAt,
            awakeSince: monitoringSince,
            now: now
        )
    }

    /// Nothing is arriving and there is no update to explain it.
    ///
    /// Two guards keep this from crying wolf, and both are needed. The Mac must
    /// have been awake for the whole window, because the last observation is
    /// always old for a moment after waking and a sleeping Mac records nothing
    /// by design. And an agent that has only just started has no silence to
    /// measure yet -- `awakeSince` is set when monitoring starts, so its own
    /// first half hour is covered by the same guard.
    static func unexplainedSilence(
        lastObservationAt: Date?, awakeSince: Date?, now: Date
    ) -> MonitoringHealth {
        guard let awakeSince,
              now.timeIntervalSince(awakeSince) >= unexplainedSilenceThreshold
        else { return .healthy }

        guard let lastObservationAt else {
            // Never recorded anything, and has been running long enough that it
            // should have. Reported against the time it started watching.
            return .silentWhileActive(since: awakeSince)
        }
        // Silence is only counted from the later of the two: an observation
        // from before the Mac went to sleep says nothing about now.
        let silentSince = max(lastObservationAt, awakeSince)
        guard now.timeIntervalSince(silentSince) >= unexplainedSilenceThreshold else {
            return .healthy
        }
        return .silentWhileActive(since: lastObservationAt)
    }
}
