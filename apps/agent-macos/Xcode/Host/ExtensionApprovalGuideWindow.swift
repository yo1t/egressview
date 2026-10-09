import AppKit
import EgressViewAgentCore
import EgressViewAgentUI

/// Says where the network extension is approved on this Mac, with a button
/// that opens that pane of System Settings.
///
/// Shown once each time macOS starts waiting for approval, and again from the
/// menu. It closes itself when monitoring starts, so the last thing on screen
/// is not an instruction that no longer applies. Not modal: the user needs
/// System Settings in front while it is open.
final class ExtensionApprovalGuideWindow: NSObject, NSWindowDelegate {
    private var panel: NSPanel?
    private var shownForCurrentWait = false

    /// Called on every monitoring status. Opens the guide the first time macOS
    /// is found waiting, and closes it once that wait is over.
    func update(for status: AgentMonitoringStatus) {
        switch status {
        case .approvalRequired:
            if !shownForCurrentWait {
                shownForCurrentWait = true
                show()
            }
        case .fullActivationRequested:
            break
        default:
            shownForCurrentWait = false
            close()
        }
    }

    func show() {
        let panel = self.panel ?? makePanel()
        self.panel = panel
        NSApp.activate(ignoringOtherApps: true)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
    }

    func windowWillClose(_ notification: Notification) {
        panel = nil
    }

    @objc private func openSystemSettings() {
        NSWorkspace.shared.open(ExtensionApprovalGuide.settingsURL(for: ProcessInfo.processInfo.operatingSystemVersion))
    }

    @objc private func dismiss() {
        close()
    }

    private func makePanel() -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 260),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        panel.title = L("Allow network monitoring")
        panel.isReleasedWhenClosed = false
        panel.delegate = self

        let heading = NSTextField(wrappingLabelWithString: L(
            "Monitoring has not started. macOS is waiting for you to allow EgressView's network extension."
        ))
        heading.font = .boldSystemFont(ofSize: NSFont.systemFontSize)

        let steps = ExtensionApprovalGuide.steps(for: ProcessInfo.processInfo.operatingSystemVersion)
            .enumerated()
            .map { index, key in "\(index + 1). \(L(key))" }
            .joined(separator: "\n")
        let body = NSTextField(wrappingLabelWithString: steps)

        let footnote = NSTextField(wrappingLabelWithString: L(
            "This window closes by itself once monitoring starts. Nothing is recorded until then."
        ))
        footnote.textColor = .secondaryLabelColor
        footnote.font = .systemFont(ofSize: NSFont.smallSystemFontSize)

        let open = NSButton(title: L("Open System Settings"), target: self, action: #selector(openSystemSettings))
        open.keyEquivalent = "\r"
        let later = NSButton(title: L("Close"), target: self, action: #selector(dismiss))
        // The row spans the window and the buttons keep their own width, at
        // the trailing edge where macOS puts the default button.
        let spacer = NSView()
        spacer.setContentHuggingPriority(.init(1), for: .horizontal)
        for button in [later, open] {
            button.setContentHuggingPriority(.required, for: .horizontal)
        }
        let buttons = NSStackView(views: [spacer, later, open])
        buttons.orientation = .horizontal
        buttons.spacing = 8

        let stack = NSStackView(views: [heading, body, footnote, buttons])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.setCustomSpacing(16, after: footnote)
        for label in [heading, body, footnote] {
            label.preferredMaxLayoutWidth = 420
        }
        stack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            stack.topAnchor.constraint(equalTo: content.topAnchor),
            stack.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            stack.widthAnchor.constraint(equalToConstant: 460),
            buttons.trailingAnchor.constraint(equalTo: stack.trailingAnchor, constant: -20),
        ])
        panel.contentView = content
        return panel
    }
}
