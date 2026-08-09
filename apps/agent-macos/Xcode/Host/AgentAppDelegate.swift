import AppKit
import EgressViewAgentCore

final class AgentAppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private lazy var journalResult = makeJournal()
    private lazy var journal = try? journalResult.get()
    private lazy var observationWindow = ObservationWindowController(journal: journal)
    private lazy var controller = AgentMonitoringController(
        journal: journal,
        statusHandler: { [weak self] status in
            DispatchQueue.main.async { self?.render(status) }
        },
        observationHandler: { [weak self] _ in
            DispatchQueue.main.async { self?.observationWindow.noteObservationsAvailable() }
        },
        storageErrorHandler: { [weak self] error in
            DispatchQueue.main.async { self?.observationWindow.showStorageError(error.localizedDescription) }
        }
    )

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "EgressView"
        render(.paused)
        if case .failure(let error) = journalResult {
            observationWindow.showStorageError(error.localizedDescription)
        }
    }

    private func render(_ status: AgentMonitoringStatus) {
        let menu = NSMenu()
        let statusRow = NSMenuItem(title: status.label, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)
        menu.addItem(.separator())
        menu.addItem(item("Open connection activity...", action: #selector(openObservations), key: "o"))
        menu.addItem(.separator())
        menu.addItem(item("Full monitoring", action: #selector(selectFull)))
        menu.addItem(item("Lightweight monitoring", action: #selector(selectLightweight)))
        menu.addItem(item("Pause", action: #selector(selectPaused)))
        menu.addItem(.separator())
        menu.addItem(item("Quit EgressView Agent", action: #selector(quit), key: "q"))
        statusItem.menu = menu
        statusItem.button?.title = status.menuBarLabel
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

    @objc private func selectLightweight() {
        controller.selectLightweightMonitoring()
    }

    @objc private func selectPaused() {
        controller.pause()
    }

    @objc private func quit() {
        controller.pause()
        NSApplication.shared.terminate(nil)
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
