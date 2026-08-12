import AppKit
import EgressViewAgentCore

final class AgentAppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let launchAtLoginController = LaunchAtLoginController()
    private let historyMaintenanceQueue = DispatchQueue(label: "com.egressview.agent.history-maintenance")
    private var currentMonitoringStatus = AgentMonitoringStatus.paused
    private var launchAtLoginError: String?
    private lazy var journalResult = makeJournal()
    private lazy var journal = try? journalResult.get()
    private lazy var observationWindow = ObservationWindowController(journal: journal)
    private lazy var hubDelivery = HubDeliveryController()
    private lazy var controller = AgentMonitoringController(
        journal: journal,
        statusHandler: { [weak self] status in
            DispatchQueue.main.async { self?.render(status) }
        },
        observationHandler: { [weak self] observations in
            self?.hubDelivery.enqueue(observations)
            DispatchQueue.main.async { self?.observationWindow.noteObservationsAvailable() }
        },
        storageErrorHandler: { [weak self] error in
            DispatchQueue.main.async { self?.observationWindow.showStorageError(error.localizedDescription) }
        }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyMenuBarIcon(for: .paused)
        _ = hubDelivery
        render(.paused)
        if case .failure(let error) = journalResult {
            observationWindow.showStorageError(error.localizedDescription)
        }
        applyRetentionPolicy()
        controller.restoreMonitoringState()
    }

    private func render(_ status: AgentMonitoringStatus) {
        currentMonitoringStatus = status
        let menu = NSMenu()
        let statusRow = NSMenuItem(title: status.label, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)
        menu.addItem(.separator())
        menu.addItem(item("Open connection activity...", action: #selector(openObservations), key: "o"))
        menu.addItem(item("Hub delivery...", action: #selector(openHubDelivery)))
        menu.addItem(.separator())
        menu.addItem(item("Full monitoring", action: #selector(selectFull)))
        menu.addItem(item("Lightweight monitoring", action: #selector(selectLightweight)))
        menu.addItem(item("Pause", action: #selector(selectPaused)))
        menu.addItem(.separator())
        let launchAtLoginItem = item(launchAtLoginTitle, action: #selector(toggleLaunchAtLogin))
        launchAtLoginItem.state = launchAtLoginController.state == .enabled ? .on : .off
        menu.addItem(launchAtLoginItem)
        if let launchAtLoginError {
            let errorItem = NSMenuItem(title: "Launch at login failed: \(launchAtLoginError)", action: nil, keyEquivalent: "")
            errorItem.isEnabled = false
            menu.addItem(errorItem)
        }
        menu.addItem(.separator())
        menu.addItem(item("Quit EgressView Agent", action: #selector(quit), key: "q"))
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

    private var launchAtLoginTitle: String {
        launchAtLoginController.state == .requiresApproval
            ? "Launch at login (Approval required...)"
            : "Launch at login"
    }

    private func item(_ title: String, action: Selector, key: String = "") -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        return item
    }

    @objc private func selectFull() {
        controller.selectFullMonitoring()
    }

    @objc private func openObservations() {
        observationWindow.show()
    }

    @objc private func openHubDelivery() {
        hubDelivery.show()
    }

    @objc private func selectLightweight() {
        controller.selectLightweightMonitoring()
    }

    @objc private func selectPaused() {
        controller.pause()
    }

    @objc private func toggleLaunchAtLogin() {
        do {
            try launchAtLoginController.toggle()
            launchAtLoginError = nil
        } catch {
            launchAtLoginError = error.localizedDescription
        }
        render(currentMonitoringStatus)
    }

    @objc private func quit() {
        controller.pause()
        NSApplication.shared.terminate(nil)
    }

    private func applyRetentionPolicy() {
        let days = ObservationWindowController.configuredRetentionDays
        guard days > 0, let journal else { return }
        historyMaintenanceQueue.async { [weak self] in
            let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: Date()) ?? Date()
            do {
                try journal.removeObservations(before: cutoff)
            } catch {
                DispatchQueue.main.async {
                    self?.observationWindow.showStorageError(error.localizedDescription)
                }
            }
        }
    }

    private func makeJournal() -> Result<ObservationJournal, Error> {
        do {
            return .success(try ObservationJournal())
        } catch {
#if DEBUG
            let fallback = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("EgressView Agent", isDirectory: true)
                .appendingPathComponent("observations.jsonl")
            return .success(ObservationJournal(fileURL: fallback))
#else
            return .failure(error)
#endif
        }
    }
}
