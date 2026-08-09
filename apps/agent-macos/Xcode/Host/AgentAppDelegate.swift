import AppKit
import EgressViewAgentCore

final class AgentAppDelegate: NSObject, NSApplicationDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private lazy var controller = AgentMonitoringController { [weak self] status in
        DispatchQueue.main.async { self?.render(status) }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem.button?.title = "EgressView"
        render(.paused)
    }

    private func render(_ status: AgentMonitoringStatus) {
        let menu = NSMenu()
        let statusRow = NSMenuItem(title: status.label, action: nil, keyEquivalent: "")
        statusRow.isEnabled = false
        menu.addItem(statusRow)
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
}
