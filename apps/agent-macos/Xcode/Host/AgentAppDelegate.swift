import AppKit
import EgressViewAgentCore
import OSLog

@MainActor
final class AgentAppDelegate: NSObject, NSApplicationDelegate {
    private let logger = Logger(subsystem: "com.egressview.agent.macos", category: "storage")
    private struct StorageContext {
        let store: ObservationStore
        let migration: ObservationJournalMigrationResult
    }

    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let launchAtLoginController = LaunchAtLoginController()
    private let historyMaintenanceQueue = DispatchQueue(label: "com.egressview.agent.history-maintenance")
    private var currentMonitoringStatus = AgentMonitoringStatus.paused
    private var checkedLaunchAtLoginForActiveMonitoring = false
    private var isPreparedForRemoval = false
    private lazy var storageResult = makeStorage()
    private lazy var store = try? storageResult.get().store
    private lazy var observationWindow = ObservationWindowController(store: store)
    private lazy var hubDelivery = HubDeliveryController()
    private lazy var updateController = AgentUpdateController(
        onUpdateReady: { [weak self] version in self?.showUpdateReady(version: version) }
    )
    private lazy var uninstallController = AgentUninstallController(
        store: store,
        monitoringController: controller,
        hubDelivery: hubDelivery,
        launchController: launchAtLoginController,
        onPreparedForRemoval: { [weak self] in
            self?.isPreparedForRemoval = true
            self?.render(.paused)
        }
    )
    private lazy var geoCacheController = GeoCacheController(
        store: store,
        credentialStore: KeychainAgentCredentialStore(),
        agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    )
    private lazy var settingsWindow = SettingsWindowController(
        store: store,
        hub: hubDelivery,
        updates: updateController,
        uninstall: uninstallController,
        geo: geoCacheController,
        launchController: launchAtLoginController,
        onMonitoringMode: { [weak self] mode in self?.selectMonitoringMode(mode) },
        onRetentionChanged: { [weak self] days in self?.applyRetentionPolicy(days: days) },
        onLanguageChanged: { [weak self] in self?.refreshLocalization() }
    )
    private lazy var controller = AgentMonitoringController(
        store: store,
        statusHandler: { [weak self] status in
            DispatchQueue.main.async { self?.render(status) }
        },
        observationHandler: { [weak self] observations in
            DispatchQueue.main.async {
                if self?.isPreparedForRemoval == false {
                    self?.hubDelivery.enqueue(observations)
                }
                self?.observationWindow.noteObservationsAvailable()
            }
        },
        storageErrorHandler: { [weak self] error in
            DispatchQueue.main.async { self?.observationWindow.showStorageError(error.localizedDescription) }
        }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyMenuBarIcon(for: .paused)
        _ = hubDelivery
        installApplicationMenu()
        render(.paused)
        if case .failure(let error) = storageResult {
            observationWindow.showStorageError(error.localizedDescription)
        } else if case .success(let context) = storageResult,
                  context.migration.malformedLineCount > 0 {
            observationWindow.showStorageError(
                L(
                    "Imported %lld legacy records. The old journal was kept because %lld lines need recovery.",
                    context.migration.importedCount,
                    context.migration.malformedLineCount
                )
            )
        }
        applyRetentionPolicy()
        controller.restoreMonitoringState()
        // Asks macOS whether monitoring is really running, rather than assuming
        // that installing it was enough.
        controller.startHealthChecks()
        showUpdateDisclosureIfNeeded()
        Task { await updateController.runIfDue() }
        // Fetches immediately when nothing is stored yet. Making a fresh
        // install wait a day for its first map would be a strange welcome.
        geoCacheController.start()
    }

    private func render(_ status: AgentMonitoringStatus) {
        currentMonitoringStatus = status
        if status == .fullActive, !checkedLaunchAtLoginForActiveMonitoring {
            checkedLaunchAtLoginForActiveMonitoring = true
            do {
                try launchAtLoginController.ensureEnabledForMonitoring()
            } catch {
                logger.error("Could not enable launch at login: \(error.localizedDescription, privacy: .public)")
            }
        }
        observationWindow.updateMonitoringStatus(status)
        settingsWindow.updateMonitoringStatus(status)
        let menu = NSMenu()
        let statusRow = NSMenuItem(title: status.label, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)
        menu.addItem(.separator())
        menu.addItem(item(L("Open EgressView..."), action: #selector(openObservations), key: "o"))
        menu.addItem(item(L("Settings..."), action: #selector(openSettings), key: ","))
        menu.addItem(item(L("About EgressView Agent"), action: #selector(openAbout)))
        if let version = updateController.availableVersion {
            menu.addItem(item(L("Update %@ ready...", version), action: #selector(openSettings)))
        }
        menu.addItem(.separator())
        menu.addItem(monitoringItem(L("Network monitoring"), action: #selector(selectFull), mode: .full))
        if controller.isLightweightMonitoringAvailable {
            menu.addItem(monitoringItem(
                L("Lightweight monitoring"),
                action: #selector(selectLightweight),
                mode: .lightweight
            ))
        }
        menu.addItem(monitoringItem(L("Pause"), action: #selector(selectPaused), mode: .paused))
        menu.addItem(.separator())
        menu.addItem(item(L("Quit EgressView Agent"), action: #selector(quit), key: "q"))
        statusItem.menu = menu
        applyMenuBarIcon(for: status)
    }

    /// Shows the agent state as an icon rather than a text label.
    ///
    /// The label used to sit in the menu bar permanently, costing 70-130pt of a
    /// bar that every other app also competes for. The state still has to be
    /// perceivable, so it moves to three template images that differ in shape,
    /// not colour: a template image is drawn in a single colour that macOS
    /// inverts for the light and dark menu bar, so colour cannot carry meaning.
    ///
    /// The full wording stays reachable: it is the first row of the menu, and
    /// it is set as the accessibility label so nothing is lost for anyone using
    /// VoiceOver. Dropping the text without this would remove the state from
    /// non-visual users entirely.
    private func applyMenuBarIcon(for status: AgentMonitoringStatus) {
        guard let button = statusItem.button else { return }
        let image = NSImage(named: status.menuBarImageName)
        image?.isTemplate = true
        button.image = image
        button.imagePosition = .imageOnly
        // Fall back to the old label if the asset is missing, so a packaging
        // mistake degrades to a working menu bar instead of an invisible one.
        button.title = image == nil ? status.menuBarLabel : ""
        button.setAccessibilityLabel(status.menuBarLabel)
        button.toolTip = status.label
    }

    private func item(_ title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func monitoringItem(_ title: String, action: Selector, mode: AgentMonitoringMode) -> NSMenuItem {
        let menuItem = item(title, action: action)
        menuItem.state = monitoringMode(for: currentMonitoringStatus) == mode ? .on : .off
        menuItem.isEnabled = !isPreparedForRemoval
        return menuItem
    }

    @objc private func selectFull() {
        guard !isPreparedForRemoval else { return }
        controller.selectFullMonitoring()
    }

    @objc private func openObservations() {
        observationWindow.show()
    }

    @objc private func openSettings() {
        settingsWindow.show()
    }

    @objc private func openAbout() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        NSApplication.shared.orderFrontStandardAboutPanel(nil)
    }

    @objc private func selectLightweight() {
        guard !isPreparedForRemoval else { return }
        controller.selectLightweightMonitoring()
    }

    @objc private func selectPaused() {
        guard !isPreparedForRemoval else { return }
        controller.pause()
    }

    @objc private func quit() {
        controller.pause()
        NSApplication.shared.terminate(nil)
    }

    private func applyRetentionPolicy(days: Int? = nil) {
        let days = days ?? ObservationWindowController.configuredRetentionDays
        guard let store else { return }
        historyMaintenanceQueue.async { [weak self] in
            do {
                store.setRetention(ObservationRetention(retentionDays: days, rawDays: 14))
                try store.compact()
            } catch {
                DispatchQueue.main.async {
                    self?.observationWindow.showStorageError(error.localizedDescription)
                }
            }
        }
    }

    private func selectMonitoringMode(_ mode: AgentMonitoringMode) {
        guard !isPreparedForRemoval else { return }
        switch mode {
        case .full: controller.selectFullMonitoring()
        case .lightweight: controller.selectLightweightMonitoring()
        case .paused: controller.pause()
        }
    }

    private func monitoringMode(for status: AgentMonitoringStatus) -> AgentMonitoringMode? {
        switch status {
        case .fullActive, .fullStarting, .fullActivationRequested, .approvalRequired,
             .rebootRequired, .updateNotRunning:
            // A stalled update is still full monitoring as far as the mode
            // picker goes; the user chose it, and it is not their setting that
            // is wrong.
            return .full
        case .lightweight: return .lightweight
        case .paused: return .paused
        case .deactivating, .removalApprovalRequired, .removalRebootRequired, .failed: return nil
        }
    }

    private func installApplicationMenu() {
        let mainMenu = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu()
        applicationMenu.addItem(item(L("About EgressView Agent"), action: #selector(openAbout)))
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(item(L("Settings..."), action: #selector(openSettings), key: ","))
        applicationMenu.addItem(.separator())
        applicationMenu.addItem(item(L("Quit EgressView Agent"), action: #selector(quit), key: "q"))
        applicationItem.submenu = applicationMenu
        mainMenu.addItem(applicationItem)
        NSApplication.shared.mainMenu = mainMenu
    }

    private func refreshLocalization() {
        installApplicationMenu()
        settingsWindow.refreshLocalization()
        render(currentMonitoringStatus)
    }

    private func showUpdateDisclosureIfNeeded() {
        guard updateController.shouldShowDisclosure else { return }
        updateController.markDisclosureShown()
        guard updateController.isEnabled else { return }
        let alert = NSAlert()
        alert.messageText = L("Automatic update checks are on")
        alert.informativeText = L(
            "EgressView checks once per day for a signed release. The request includes the Agent version and macOS version, but no device or installation identifier. Updates are downloaded and verified, then you decide when to open the installer."
        )
        alert.addButton(withTitle: L("Keep enabled"))
        alert.addButton(withTitle: L("Turn off"))
        if alert.runModal() == .alertSecondButtonReturn {
            updateController.setEnabled(false)
        }
    }

    private func showUpdateReady(version: String) {
        render(currentMonitoringStatus)
        let alert = NSAlert()
        alert.messageText = L("EgressView Agent %@ is ready", version)
        alert.informativeText = L(
            "The installer passed the signed manifest, checksum, developer identity and Gatekeeper checks. You choose when to open it because installation temporarily stops monitoring."
        )
        alert.addButton(withTitle: L("Open installer"))
        alert.addButton(withTitle: L("Later"))
        if alert.runModal() == .alertFirstButtonReturn {
            updateController.openVerifiedInstaller()
        }
    }

    private func makeStorage() -> Result<StorageContext, Error> {
        do {
            let retention = ObservationRetention(
                retentionDays: ObservationWindowController.configuredRetentionDays,
                rawDays: 14
            )
            let journal = try ObservationJournal()
            let store = try ObservationStore(retention: retention)
            let migration = try ObservationJournalMigrator.migrate(journal: journal, into: store)
            return .success(StorageContext(store: store, migration: migration))
        } catch {
            logger.error("Storage initialization failed: \(error.localizedDescription, privacy: .public)")
#if DEBUG
            do {
                let fallback = FileManager.default.urls(
                    for: .applicationSupportDirectory,
                    in: .userDomainMask
                )[0].appendingPathComponent("EgressView Agent", isDirectory: true)
                let retention = ObservationRetention(
                    retentionDays: ObservationWindowController.configuredRetentionDays,
                    rawDays: 14
                )
                let journal = ObservationJournal(
                    fileURL: fallback.appendingPathComponent("observations.jsonl")
                )
                let store = try ObservationStore(
                    fileURL: fallback.appendingPathComponent("observations.sqlite"),
                    retention: retention
                )
                let migration = try ObservationJournalMigrator.migrate(journal: journal, into: store)
                return .success(StorageContext(store: store, migration: migration))
            } catch {
                return .failure(error)
            }
#else
            return .failure(error)
#endif
        }
    }
}
