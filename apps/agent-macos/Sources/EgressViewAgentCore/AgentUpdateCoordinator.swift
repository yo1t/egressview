import Foundation

public enum AgentUpdateState: Equatable, Sendable {
    case disabled
    case notDue
    case upToDate(checkedAt: Date)
    /// Downloaded, hash-checked against the signed manifest, and accepted by
    /// Gatekeeper. Installing it is a separate, user-visible act.
    case readyToInstall(version: String, package: URL)
    case failed(String)
}

/// Runs the daily update check and carries it as far as a verified package.
///
/// It deliberately stops there. The decision recorded in P3-23 is that the
/// default is to tell the user and let them install: monitoring stops while the
/// agent is replaced, and the system extension may need re-approval afterwards.
/// **An update that silently stops the monitoring is worse than one the user
/// has not installed yet**, because nobody notices the first kind.
public actor AgentUpdateCoordinator {
    private let checker: AgentUpdateChecker
    private let downloader: AgentUpdateDownloader
    private let verifier: AgentPackageVerifier
    private let preferences: AgentUpdatePreferences
    private let clock: @Sendable () -> Date

    public private(set) var state: AgentUpdateState = .notDue

    public init(
        checker: AgentUpdateChecker,
        downloader: AgentUpdateDownloader = AgentUpdateDownloader(),
        verifier: AgentPackageVerifier = AgentPackageVerifier(),
        preferences: AgentUpdatePreferences = AgentUpdatePreferences(),
        clock: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.checker = checker
        self.downloader = downloader
        self.verifier = verifier
        self.preferences = preferences
        self.clock = clock
    }

    @discardableResult
    public func runIfDue(offline: Bool = false) async -> AgentUpdateState {
        guard preferences.isEnabled, !offline else {
            state = .disabled
            return state
        }
        let now = clock()
        guard preferences.shouldCheck(now: now, offline: offline) else {
            state = .notDue
            return state
        }
        return await run(now: now)
    }

    /// Bypasses the schedule for an explicit "check now" from the user, who is
    /// waiting for an answer and should get one.
    @discardableResult
    public func runNow() async -> AgentUpdateState {
        await run(now: clock())
    }

    private func run(now: Date) async -> AgentUpdateState {
        // Recorded before the work starts, so a check that crashes or hangs
        // still counts as an attempt and cannot spin on every launch.
        preferences.lastAttemptedAt = now
        do {
            switch try await checker.check() {
            case .upToDate:
                preferences.lastCheckedAt = now
                state = .upToDate(checkedAt: now)
            case let .updateAvailable(version, package):
                let file = try await downloader.download(package, userAgent: checker.userAgent)
                do {
                    try verifier.verify(packageAt: file)
                } catch {
                    // A package that fails verification is deleted rather than
                    // left behind for someone to open by hand.
                    try? FileManager.default.removeItem(at: file)
                    throw error
                }
                preferences.lastCheckedAt = now
                state = .readyToInstall(version: version, package: file)
            }
        } catch {
            // No `lastCheckedAt` on failure: the daily clock only advances when
            // an answer was actually obtained.
            state = .failed(Self.describe(error))
        }
        return state
    }

    /// Phrased for someone who has to decide what to do, not for a log reader.
    public static func describe(_ error: any Error) -> String {
        switch error {
        case AgentUpdateError.embeddedKeyNotPublished:
            return "This build does not carry the published EgressView release key, so updates are refused."
        case AgentUpdateError.signatureInvalid:
            return "The update information was not signed by the EgressView release key."
        case let AgentUpdateError.httpStatus(code):
            return "The update service returned HTTP \(code)."
        case let AgentUpdateError.transport(reason):
            return "Could not reach the update service: \(reason)"
        case let AgentUpdateDownloadError.checksumMismatch(_, actual):
            return "The downloaded package did not match the signed checksum (got \(actual.prefix(12))…)."
        case let AgentUpdateDownloadError.sizeMismatch(expected, actual):
            return "The download was incomplete (\(actual) of \(expected) bytes)."
        case AgentPackageVerificationError.runningBuildIsNotTeamSigned:
            return "This build is not signed with a developer identity, so it cannot verify an update."
        case let AgentPackageVerificationError.teamIdentifierMismatch(_, actual):
            return "The downloaded package was signed by a different developer (\(actual))."
        case let AgentPackageVerificationError.notarisationRejected(reason):
            return "macOS refused the downloaded package: \(reason)"
        default:
            return String(describing: error)
        }
    }
}
