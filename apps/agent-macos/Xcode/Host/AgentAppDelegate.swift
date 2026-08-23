import AppKit
import Combine
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
    private var currentQUICDiagnostics: QUICFeasibilityDiagnostics?
    private var checkedLaunchAtLoginForActiveMonitoring = false
    private var isPreparedForRemoval = false
    private lazy var storageResult = makeStorage()
    private lazy var store = try? storageResult.get().store
    /// SwiftUI windows are expensive even while hidden. Create them only when
    /// requested and release their hosting trees when they close.
    private var observationWindow: ObservationWindowController?
    private var settingsWindow: SettingsWindowController?
    private var pendingStorageError: String?
    private var threatAvailabilityObserver: AnyCancellable?
    private var updateAvailabilityObserver: AnyCancellable?
    private let chartFoldTimer = PeriodicWork()
    private var activity: NSObjectProtocol?
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
    private lazy var threatIntelController = ThreatIntelController(
        store: store,
        credentialStore: KeychainAgentCredentialStore(),
        agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    )
    private lazy var diagnosticsExporter = AgentDiagnosticsExporter(
        store: store,
        monitoring: { [weak self] in self?.currentMonitoringStatus ?? .paused },
        hubDelivery: hubDelivery,
        threatIntel: threatIntelController
    )
    private lazy var notificationCoordinator = AgentNotificationCoordinator(
        store: store, hub: hubDelivery, threats: threatIntelController,
        notifier: AgentUserNotifier.shared
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
                self?.observationWindow?.noteObservationsAvailable()
            }
        },
        storageErrorHandler: { [weak self] error in
            DispatchQueue.main.async { self?.recordStorageError(error.localizedDescription) }
        },
        diagnosticsHandler: { [weak self] diagnostics in
            DispatchQueue.main.async {
                self?.currentQUICDiagnostics = diagnostics
                self?.settingsWindow?.updateQUICDiagnostics(diagnostics)
            }
        }
    )

    /// Folds each completed hour into the aggregate the charts read.
    ///
    /// On a timer rather than on every observation: folding an hour costs about
    /// 20 ms here, and doing that work as rows arrive would put it in the path
    /// of collection, which must not be slowed for the sake of a chart. Once at
    /// launch so a database that has been closed for a while catches up.
    /// Asks macOS not to put the agent to sleep while the Mac is awake.
    ///
    /// A background accessory app with no windows is what App Nap exists to
    /// throttle, and being throttled stops the very work this app is for:
    /// checking that monitoring is alive, folding the hourly aggregate,
    /// refreshing threat indicators. Measured on 2026-08-19 -- a 60-second
    /// timer fired zero times in 200 seconds.
    ///
    /// `...AllowingIdleSystemSleep` on purpose. The agent should keep working
    /// while the Mac is awake and must not be the reason it stays awake; a
    /// monitoring tool that quietly drains a battery would be uninstalled, and
    /// deservedly.
    private func keepRunningWhileAwake() {
        activity = ProcessInfo.processInfo.beginActivity(
            options: .userInitiatedAllowingIdleSystemSleep,
            reason: "Watching network activity and checking that monitoring is alive"
        )
    }

    private func startChartFolding() {
        foldCharts()
        chartFoldTimer.start(every: 300) { [weak self] in self?.foldCharts() }
    }

    private func foldCharts() {
        guard let store else { return }
        DispatchQueue.global(qos: .utility).async {
            do {
                try store.foldCompletedHoursForCharts()
            } catch {
                // A fold that fails leaves the watermark where it was, so the
                // charts fall back to the raw rows for those hours: slower, and
                // still correct.
                self.logger.error(
                    "Could not fold hours for the charts: \(error.localizedDescription, privacy: .public)"
                )
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        // Closes the current stretch of coverage. A session left open would
        // claim the app was watching for however long it was quit.
        controller.endCoverageForShutdown()
        try? store?.flushCountryVisitSummary()
        notificationCoordinator.stop()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyMenuBarIcon(for: .paused)
        _ = hubDelivery
        installApplicationMenu()
        render(.paused)
        if case .failure(let error) = storageResult {
            recordStorageError(error.localizedDescription)
        } else if case .success(let context) = storageResult,
                  context.migration.malformedLineCount > 0 {
            recordStorageError(
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
        keepRunningWhileAwake()
        controller.startHealthChecks()
        controller.startWatchingSleep()
        startChartFolding()
        showUpdateDisclosureIfNeeded()
        Task { await updateController.runIfDue() }
        // Fetches immediately when nothing is stored yet. Making a fresh
        // install wait a day for its first map would be a strange welcome.
        geoCacheController.start()
        threatIntelController.start()
        notificationCoordinator.start()
        // The window needs to know whether anyone was in a position to look, so
        // that "found nothing" is never shown for "never checked".
        threatAvailabilityObserver = threatIntelController.$availability.sink { [weak self] value in
            self?.observationWindow?.setThreatAvailability(value)
        }
        // The menu is built from the monitoring status, so it was only rebuilt
        // when that changed. An update that appeared -- or was cleared --
        // stayed on the menu until something unrelated happened to redraw it,
        // which is how a stale "update available" survived being cleared.
        updateAvailabilityObserver = updateController.$availableVersion
            .removeDuplicates()
            .sink { [weak self] _ in
                guard let self else { return }
                DispatchQueue.main.async { self.render(self.currentMonitoringStatus) }
            }
    }

    private func render(_ status: AgentMonitoringStatus) {
        currentMonitoringStatus = status
        notificationCoordinator.handleMonitoringStatus(status)
        if status == .fullActive, !checkedLaunchAtLoginForActiveMonitoring {
            checkedLaunchAtLoginForActiveMonitoring = true
            do {
                try launchAtLoginController.ensureEnabledForMonitoring()
            } catch {
                logger.error("Could not enable launch at login: \(error.localizedDescription, privacy: .public)")
            }
        }
        observationWindow?.updateMonitoringStatus(status)
        settingsWindow?.updateMonitoringStatus(status)
        let menu = NSMenu()
        let statusRow = NSMenuItem(title: status.label, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)
        menu.addItem(.separator())
        menu.addItem(item(L("Open EgressView..."), action: #selector(openObservations), key: "o"))
        menu.addItem(item(L("Settings..."), action: #selector(openSettings), key: ","))
        menu.addItem(item(L("About EgressView Agent"), action: #selector(openAbout)))
        menu.addItem(item(L("Save diagnostics..."), action: #selector(saveDiagnostics)))
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
        // Spelled out while nothing is being recorded, and only then. Fall back
        // to the label too if the asset is missing, so a packaging mistake
        // degrades to a working menu bar instead of an invisible one.
        let showsLabel = status.menuBarShowsLabel || image == nil
        button.imagePosition = showsLabel
            ? (image == nil ? .noImage : .imageLeading)
            : .imageOnly
        button.title = showsLabel ? status.menuBarLabel : ""
        button.setAccessibilityLabel(status.menuBarLabel)
        button.toolTip = status.label
    }

    private func item(_ title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    private func observationWindowController() -> ObservationWindowController {
        if let observationWindow { return observationWindow }
        let controller = ObservationWindowController(store: store) { [weak self] in
            self?.observationWindow = nil
        }
        controller.updateMonitoringStatus(currentMonitoringStatus)
        controller.setThreatAvailability(threatIntelController.availability)
        if let pendingStorageError {
            controller.showStorageError(pendingStorageError)
            self.pendingStorageError = nil
        }
        observationWindow = controller
        return controller
    }

    private func settingsWindowController() -> SettingsWindowController {
        if let settingsWindow { return settingsWindow }
        let controller = SettingsWindowController(
            store: store,
            hub: hubDelivery,
            updates: updateController,
            uninstall: uninstallController,
            geo: geoCacheController,
            threats: threatIntelController,
            launchController: launchAtLoginController,
            onMonitoringMode: { [weak self] mode in self?.selectMonitoringMode(mode) },
            onRetentionChanged: { [weak self] days in self?.applyRetentionPolicy(days: days) },
            onLanguageChanged: { [weak self] in self?.refreshLocalization() },
            onServerNameChanged: { [weak self] enabled in
                self?.controller.setReadsServerName(enabled)
            },
            onRefreshQUICDiagnostics: { [weak self] in self?.controller.requestQUICDiagnostics() },
            onClose: { [weak self] in self?.settingsWindow = nil }
        )
        controller.updateMonitoringStatus(currentMonitoringStatus)
        controller.updateQUICDiagnostics(currentQUICDiagnostics)
        settingsWindow = controller
        return controller
    }

    private func recordStorageError(_ message: String) {
        pendingStorageError = message
        observationWindow?.showStorageError(message)
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
        observationWindowController().show()
    }

    @objc private func openSettings() {
        settingsWindowController().show()
    }

    /// Deliberately in the menu rather than behind a settings screen. It is
    /// wanted when the agent is misbehaving, and a screen that will not open is
    /// a poor place to keep the thing that explains why.
    @objc private func saveDiagnostics() {
        diagnosticsExporter.export()
    }

    @objc private func openAbout() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        var options: [NSApplication.AboutPanelOptionKey: Any] = [:]
        if let url = Bundle.main.url(forResource: "ThirdPartyNotices", withExtension: "txt"),
           let notices = try? String(contentsOf: url, encoding: .utf8) {
            options[.credits] = NSAttributedString(string: notices)
        }
        NSApplication.shared.orderFrontStandardAboutPanel(options: options)
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
                    self?.recordStorageError(error.localizedDescription)
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
             .rebootRequired, .updateNotRunning, .notRecording, .diagnosticNotRecording:
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
        settingsWindow?.refreshLocalization()
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
            updateController.openInstaller()
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
