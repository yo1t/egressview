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
            Task { await runIfDue() }
        } else {
            render(.disabled)
        }
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

    /// Opens the release in the user's browser.
    ///
    /// The agent used to download the package itself and open it. That could
    /// not work: macOS marks anything a sandboxed application writes, and
    /// refuses to launch an app dragged out of it. The download belongs on the
    /// ordinary path, where Gatekeeper checks it at first launch as it does for
    /// every other download.
    ///
    /// What this agent still guarantees is the address: the manifest carrying
    /// it was signed with the EgressView release key, checked before this
    /// button appears.
    func openDownloadPage() {
        guard let packageURL else {
            status = L("No download address for this release. Check again.")
            return
        }
        guard NSWorkspace.shared.open(packageURL) else {
            status = L("Could not open the browser. The download is at %@", packageURL.absoluteString)
            return
        }
        status = L("The download opened in your browser. Quit this app before replacing it in Applications.")
        promptToQuitForReplacement()
    }

    /// Asks whether to quit so the installed copy can be replaced.
    ///
    /// Quitting stops collection until the new copy is launched. That is said
    /// plainly: an agent that stops watching without saying so is the fault
    /// this release spent the most effort removing.
    private func promptToQuitForReplacement() {
        let alert = NSAlert()
        alert.messageText = L("Quit EgressView Agent to replace it?")
        alert.informativeText = L("macOS cannot replace an application while it is running, so dragging the new copy to Applications fails until this one quits. Nothing is recorded between quitting and opening the new copy.")
        alert.addButton(withTitle: L("Quit and replace"))
        alert.addButton(withTitle: L("Not now"))
        alert.alertStyle = .informational
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else {
            status = L("Quit EgressView Agent before dragging the new copy to Applications.")
            return
        }
        // A moment so the installer window is in front when the app goes away,
        // rather than the desktop.
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
            NSApp.terminate(nil)
        }
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
                status = L("Version %@ is available. Downloading opens in your browser.", availableVersion)
            } else if let checked = preferences.lastCheckedAt {
                status = L("Last checked: %@", Self.format(checked))
            } else {
                status = L("Updates are checked once per day.")
            }
        case .upToDate(let checkedAt):
            clearVerifiedPackage(deleteFile: true)
            status = L("Up to date. Checked %@", Self.format(checkedAt))
        case let .updateAvailable(version, url):
            rememberAvailableUpdate(version: version, url: url)
            status = L("Version %@ is available. Downloading opens in your browser.", version)
        case .failed(let message):
            status = L("Update check failed: %@", message)
        }
    }

    private func restoreVerifiedPackage() {
        guard let version = defaults.string(forKey: Self.readyVersionKey),
              let path = defaults.string(forKey: Self.readyPackageKey) else {
            return
        }
        guard let package = URL(string: path), package.scheme == "https" else {
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
        if packageURL != package { clearVerifiedPackage(deleteFile: false) }
        availableVersion = version
        packageURL = package
        defaults.set(version, forKey: Self.readyVersionKey)
        defaults.set(package.absoluteString, forKey: Self.readyPackageKey)
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
