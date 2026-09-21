import EgressViewAgentUI
import AppKit
import EgressViewAgentCore

@MainActor
final class AgentUpdateController: ObservableObject {
    static let disclosureShownKey = "updateCheckDisclosureShown"

    @Published private(set) var isEnabled: Bool
    @Published private(set) var isChecking = false
    @Published private(set) var isOpeningInstaller = false
    @Published private(set) var status = L("Updates are checked once per day.")
    @Published private(set) var availableVersion: String?
    @Published private(set) var packageURL: URL?

    private static let readyVersionKey = "verifiedUpdateVersion"
    private static let readyPackageKey = "verifiedUpdatePackagePath"
    private static let notifiedVersionKey = "notifiedUpdateVersion"

    /// How often to ask whether a check is due. Not how often a check happens:
    /// `AgentUpdatePreferences.shouldCheck` still refuses until a day has
    /// passed. This only decides how soon after that day the check actually
    /// runs.
    private static let pollInterval: TimeInterval = 3_600

    private let timer = PeriodicWork()
    private let preferences: AgentUpdatePreferences
    private let defaults: UserDefaults
    private let coordinator: AgentUpdateCoordinator
    private let verifier: AgentPackageVerifier
    private let onUpdateReady: (String) -> Void
    private var lastState = AgentUpdateState.notDue
    /// The version running right now, so a package left over from before an
    /// install is not offered as an upgrade to it.
    private var runningVersion = "0.0.0"

    init(
        preferences: AgentUpdatePreferences = AgentUpdatePreferences(),
        defaults: UserDefaults = .standard,
        verifier: AgentPackageVerifier = AgentPackageVerifier(),
        onUpdateReady: @escaping (String) -> Void = { _ in }
    ) {
        self.preferences = preferences
        self.defaults = defaults
        self.onUpdateReady = onUpdateReady
        self.verifier = verifier
        isEnabled = preferences.isEnabled
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
            ?? "0.0.0"
        coordinator = AgentUpdateCoordinator(
            checker: AgentUpdateChecker(
                currentVersion: version,
                osVersion: ProcessInfo.processInfo.operatingSystemVersionString
            ),
            verifier: verifier,
            preferences: preferences
        )
        runningVersion = version
        restoreVerifiedPackage()
        render(.notDue)
    }

    var shouldShowDisclosure: Bool {
        !defaults.bool(forKey: Self.disclosureShownKey)
    }

    func markDisclosureShown() {
        defaults.set(true, forKey: Self.disclosureShownKey)
    }

    func setEnabled(_ enabled: Bool) {
        preferences.isEnabled = enabled
        isEnabled = enabled
        if enabled {
            start()
        } else {
            timer.stop()
            render(.disabled)
        }
    }

    /// Begin checking, and keep checking.
    ///
    /// This used to be a single `runIfDue()` at launch and nothing after it,
    /// which made "checked once per day" mean "checked once per launch". An
    /// agent is meant to be left running, so on a Mac that stays up for a week
    /// the check ran once in that week -- and the access log agreed: 31 clients
    /// produced 55 checks across 38 days, about one and a half each, which is
    /// how often a Mac is restarted rather than how often a day passes.
    ///
    /// `PeriodicWork` rather than a `Timer` for the reason written on that
    /// class: this app is a background accessory, App Nap stops its run-loop
    /// timers, and a 60-second `Timer` was measured firing zero times in 200
    /// seconds. The same mistake was found in the health check in August and
    /// fixed there; this was the last place still making it.
    func start() {
        timer.start(every: Self.pollInterval, runNow: true) { [weak self] in
            Task { @MainActor in await self?.runIfDue() }
        }
    }

    func stop() {
        timer.stop()
    }

    func runIfDue() async {
        guard !isChecking else { return }
        isChecking = true
        status = L("Checking for updates...")
        let state = await coordinator.runIfDue()
        isChecking = false
        render(state)
    }

    func checkNow() {
        guard !isChecking else { return }
        isChecking = true
        status = L("Checking for updates...")
        Task {
            let state = await coordinator.runNow()
            isChecking = false
            render(state)
        }
    }

    /// Opens the downloaded installer package.
    ///
    /// The agent downloads it after all. Handing the user a disk image could
    /// not work -- macOS marks everything a sandboxed application writes and
    /// refuses to launch an app taken from it -- but installing a package is
    /// not launching an app. `installd` does it, and a package carrying the
    /// same mark installs normally; measured on a real machine rather than
    /// assumed from the disk image's failure.
    ///
    /// The bytes were checked against the hash in a manifest signed with the
    /// release key. The package's own signature and notarisation are checked
    /// by macOS as it installs.
    func openInstaller() {
        guard let packageURL, FileManager.default.fileExists(atPath: packageURL.path) else {
            clearVerifiedPackage(deleteFile: false)
            status = L("The installer is no longer available. Check again to download it.")
            return
        }
        guard NSWorkspace.shared.open(packageURL) else {
            status = L("macOS could not open the installer.")
            return
        }
        // No prompt to quit: the package stops the running copy and starts the
        // new one itself. That was the whole point of building one.
        status = L("The installer was opened. It stops monitoring, replaces this app, and starts it again.")
    }

    func refreshLocalization() {
        render(lastState)
    }

    private func render(_ state: AgentUpdateState) {
        lastState = state
        switch state {
        case .disabled:
            status = L("Automatic update checks are off. Use Check now whenever you want to look for a release.")
        case .notDue:
            if let availableVersion {
                status = L("Version %@ is downloaded and checked. Open the installer to finish.", availableVersion)
            } else if let checked = preferences.lastCheckedAt {
                status = L("Last checked: %@", Self.format(checked))
            } else {
                status = L("Updates are checked once per day.")
            }
        case .upToDate(let checkedAt):
            clearVerifiedPackage(deleteFile: true)
            status = L("Up to date. Checked %@", Self.format(checkedAt))
        case let .readyToInstall(version, package):
            rememberAvailableUpdate(version: version, url: package)
            status = L("Version %@ is downloaded and checked. Open the installer to finish.", version)
        case .failed(let message):
            status = L("Update check failed: %@", message)
        }
    }

    private func restoreVerifiedPackage() {
        guard let version = defaults.string(forKey: Self.readyVersionKey),
              let path = defaults.string(forKey: Self.readyPackageKey) else {
            return
        }
        let package = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: package.path) else {
            clearVerifiedPackage(deleteFile: false)
            return
        }
        // A package downloaded before the app was updated some other way is
        // still on disk, and offering it would walk the user backwards. The
        // check refuses to move backwards when it runs, but nothing was
        // re-examining what had already been stored -- so the menu offered a
        // downgrade until the next check happened to run.
        guard AgentStoredUpdate.isStillAnUpgrade(
            storedVersion: version, runningVersion: runningVersion
        ) else {
            clearVerifiedPackage(deleteFile: true)
            return
        }
        availableVersion = version
        packageURL = package
    }

    private func rememberAvailableUpdate(version: String, url package: URL) {
        if packageURL != package { clearVerifiedPackage(deleteFile: true) }
        availableVersion = version
        packageURL = package
        defaults.set(version, forKey: Self.readyVersionKey)
        defaults.set(package.path, forKey: Self.readyPackageKey)
        if defaults.string(forKey: Self.notifiedVersionKey) != version {
            defaults.set(version, forKey: Self.notifiedVersionKey)
            onUpdateReady(version)
        }
    }

    private func clearVerifiedPackage(deleteFile: Bool) {
        if deleteFile, let packageURL { try? FileManager.default.removeItem(at: packageURL) }
        availableVersion = nil
        packageURL = nil
        defaults.removeObject(forKey: Self.readyVersionKey)
        defaults.removeObject(forKey: Self.readyPackageKey)
    }

    private static func format(_ date: Date) -> String {
        DateFormatter.localizedString(from: date, dateStyle: .medium, timeStyle: .short)
    }
}
