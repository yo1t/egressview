import EgressViewAgentUI
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
    /// Kept apart from `pendingStorageError`: an error is replaced by the next
    /// refresh that succeeds, and this is a fact about the last launch that
    /// stays true until the user has read it.
    private var pendingStorageNotice: String?
    private var threatAvailabilityObserver: AnyCancellable?
    private var updateAvailabilityObserver: AnyCancellable?
    private let chartFoldTimer = PeriodicWork()
    private let runHeartbeatTimer = PeriodicWork()
    /// Marks that this run started, so that a run which never gets to mark its
    /// own end is recognisable afterwards. A crashed agent cannot write a
    /// report; this is written before it needs one. (P3-41)
    private let runRecorder = AgentRunRecorder.inAppGroup()
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
    private lazy var ollamaController = AgentOllamaController()
    private lazy var diagnosticsExporter = AgentDiagnosticsExporter(
        store: store,
        extensionVersion: { [weak self] in self?.controller.enabledExtensionVersion },
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
                // The same delivery tells the connection log there is
                // something new. The rows are already in the store by the
                // time this runs, so the window re-reads rather than being
                // handed anything -- and it only does so if it is open and
                // showing the log (P3-107).
                self?.observationWindow?.observationsArrived(observations)
                // A destination nothing can name is the reason to ask again
                // (P3-115). The controller decides whether asking is allowed
                // and where to ask; this only says that something new arrived.
                Task { await self?.geoCacheController.resolveNewDestinations() }
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

    /// Records this run, and keeps a heartbeat so a later report can say how
    /// far the previous one got before it stopped.
    ///
    /// The heartbeat carries the newest observation time as well, because a run
    /// that was alive but had stopped recording and a run that was recording
    /// until it died are the same length and completely different faults.
    /// 2026-08-18 was the first kind and took thirteen hours to notice.
    /// Opens this run in the history, and closes the previous one as
    /// unexpected if it never said goodbye.
    ///
    /// Separate from the heartbeat because the two have to happen at different
    /// moments: this before the database is opened, the heartbeat after, since
    /// the heartbeat reports the newest observation and there is nothing to
    /// report it from until the store exists.
    private func beginRunRecord() {
        guard let runRecorder else { return }
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        runRecorder.beginRun(build: build ?? "unknown")
    }

    private func startRunHeartbeat() {
        guard let runRecorder else { return }
        // A minute is fine-grained enough to bound the end of a run and cheap
        // enough to ignore: one small atomic write, off the main thread.
        runHeartbeatTimer.start(every: 60) { [weak self] in
            guard let self else { return }
            DispatchQueue.global(qos: .utility).async {
                let newest = try? self.store?.storageSummary().newestObservationAt
                runRecorder.heartbeat(lastObservationAt: newest ?? nil)
            }
        }
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
        // Says goodbye. Everything that does not reach this line is, by that
        // absence, an unexpected ending -- which is the only way a process that
        // died can leave a trace of having died.
        runRecorder?.endRun()
        // Closes the current stretch of coverage. A session left open would
        // claim the app was watching for however long it was quit.
        controller.endCoverageForShutdown()
        try? store?.flushCountryVisitSummary()
        notificationCoordinator.stop()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Before the database is touched. Opening it is the most likely thing
        // to kill this process -- it checks a file of a few hundred megabytes
        // for integrity, and it is the first thing that runs -- and a run that
        // dies there used to leave no trace at all: the history's next line was
        // the run after it, so a crash looked like nothing having happened
        // (P3-133).
        //
        // The history is a small file in the App Group container, not a table
        // in the database it is describing, so it can be written when the
        // database cannot be opened at all. It only had to be written first.
        beginRunRecord()
        // A progress file that is here before anything opens the database was
        // left by a run that died in the middle of a migration. The next open
        // will try the same migration again, which is right -- but the user is
        // owed the fact that it failed once, because the alternative is that
        // an update quietly eats their records and nobody ever says so
        // (P3-161).
        let interruptedMigration = readInterruptedMigration()
        applyMenuBarIcon(for: .paused)
        _ = hubDelivery
        installApplicationMenu()
        render(.paused)
        // Only now, with the store opened, is there an outcome to report: the
        // same migration has just been run again, and the user's question is
        // whether it finished this time.
        if let interruptedMigration {
            reportInterruptedMigration(interruptedMigration)
        }
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
        startRunHeartbeat()
        controller.restoreMonitoringState()
        // Asks macOS whether monitoring is really running, rather than assuming
        // that installing it was enough.
        keepRunningWhileAwake()
        controller.startHealthChecks()
        controller.startWatchingSleep()
        startChartFolding()
        showUpdateDisclosureIfNeeded()
        // Starts the schedule as well as checking now: an agent left running
        // for a week used to check once in that week (P3-154).
        updateController.start()
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
        let controller = ObservationWindowController(store: store, ollama: ollamaController) { [weak self] in
            self?.observationWindow = nil
        }
        controller.updateMonitoringStatus(currentMonitoringStatus)
        controller.setThreatAvailability(threatIntelController.availability)
        if let pendingStorageError {
            controller.showStorageError(pendingStorageError)
            self.pendingStorageError = nil
        }
        if let pendingStorageNotice {
            controller.showStorageNotice(pendingStorageNotice)
            self.pendingStorageNotice = nil
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
            ollama: ollamaController,
            launchController: launchAtLoginController,
            onMonitoringMode: { [weak self] mode in self?.selectMonitoringMode(mode) },
            onRetentionChanged: { [weak self] days in self?.applyRetentionPolicy(days: days) },
            onLanguageChanged: { [weak self] in self?.refreshLocalization() },
            onServerNameChanged: { [weak self] enabled in
                self?.controller.setReadsServerName(enabled)
            },
            onRefreshQUICDiagnostics: { [weak self] in self?.controller.requestQUICDiagnostics() },
            onSaveDiagnostics: { [weak self] in self?.diagnosticsExporter.export() },
            onClose: { [weak self] in self?.settingsWindow = nil }
        )
        controller.updateMonitoringStatus(currentMonitoringStatus)
        controller.updateQUICDiagnostics(currentQUICDiagnostics)
        settingsWindow = controller
        return controller
    }

    /// Reads what the previous launch left behind if it died while changing
    /// the database's shape.
    ///
    /// Read before the store is opened, because opening it clears the file.
    /// Unlike Windows, nothing here can mistake a dead migration for a live
    /// one: the window and the store are one process, so by the time anyone
    /// reads this file its writer has exited (P3-166).
    private func readInterruptedMigration() -> (progress: MigrationProgress, databaseURL: URL)? {
        guard let databaseURL = try? ObservationStore.defaultFileURL(),
              let progress = MigrationProgressFile.read(forDatabaseAt: databaseURL) else { return nil }
        return (progress, databaseURL)
    }

    /// Says that the previous launch died while changing the database's shape,
    /// where it had got to, and how the retry at this launch ended.
    ///
    /// It used to say only "it will be tried again now", in the same slot as
    /// refresh errors -- and the first refresh that succeeded cleared it, so
    /// the window showed it for a moment or not at all. It now stays until it
    /// is dismissed, and it says the part the user is left wondering about:
    /// whether it worked the second time (P3-165).
    ///
    /// The copy taken before that migration is named: it is what the user
    /// would need if this keeps happening, and it is no use to them if they do
    /// not know it exists.
    private func reportInterruptedMigration(_ interrupted: (progress: MigrationProgress, databaseURL: URL)) {
        let progress = interrupted.progress
        let backup = interrupted.databaseURL.deletingPathExtension()
            .appendingPathExtension("pre-v\(progress.fromVersion).sqlite")
        let whereItStopped: String
        if let step = progress.step {
            whereItStopped = L(
                "The last update stopped at step %lld of %lld while changing how records are stored.",
                step.current, step.total
            )
        } else {
            whereItStopped = L("The last update stopped while copying the records before changing how they are stored.")
        }
        let outcome: String
        if case .success = storageResult {
            outcome = L("It was run again at this launch and finished.")
        } else {
            outcome = L("It was run again at this launch and did not finish.")
        }
        var message = whereItStopped + " " + outcome
        if FileManager.default.fileExists(atPath: backup.path) {
            message += " " + L("A copy from before it started is kept at %@.", backup.path)
        }
        pendingStorageNotice = message
        observationWindow?.showStorageNotice(message)
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
        // A choice, unlike the pause that quitting performs.
        controller.rememberChosenMode(.paused)
        controller.pause()
    }

    @objc private func quit() {
        // Stops monitoring -- an agent that is not running has no business
        // leaving a filter inspecting traffic with nothing to show for it --
        // but deliberately does not touch the setting. The next launch reads
        // that setting and puts monitoring back (P3-121).
        controller.pause()
        NSApplication.shared.terminate(nil)
    }

    private func applyRetentionPolicy(days: Int? = nil) {
        let days = days ?? ObservationWindowController.configuredRetentionDays
        guard let store else { return }
        let logger = self.logger
        historyMaintenanceQueue.async { [weak self] in
            do {
                store.setRetention(ObservationRetention(retentionDays: days, rawDays: 14))
                try store.compact()
                // After the deletes, not before: the free pages this reclaims
                // are the ones `compact` just made. Deleting rows leaves the
                // file the size it was, so without this the user deletes
                // their history and the disk does not give anything back
                // (P3-158).
                let freed = try store.reclaimFreeSpace()
                if freed > 0 {
                    logger.notice("reclaimed \(freed, privacy: .public) bytes of free pages")
                }
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
