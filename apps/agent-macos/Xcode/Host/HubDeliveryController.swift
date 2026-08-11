import AppKit
import EgressViewAgentCore
import Network

final class HubDeliveryController: NSWindowController, NSWindowDelegate {
    private let credentialStore = KeychainAgentCredentialStore()
    private let preferences = AgentDeliveryPreferences()
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "com.egressview.agent.hub-connectivity")
    private let observationQueue = DispatchQueue(label: "com.egressview.agent.hub-observations")
    private var deliverySampler = ObservationPersistenceSampler(refreshInterval: 60)
    private lazy var sender: AgentIngestSender? = makeSender()
    private var senderState: AgentIngestSenderState = .off
    private var queueStatus = AgentDeliveryQueueStatus(
        pendingCount: 0,
        droppedCount: 0,
        oldestPendingAt: nil,
        lastAcknowledgedAt: nil
    )

    private let hubField = NSTextField(string: "")
    private let codeField = NSSecureTextField(string: "")
    private let consentCheckbox = NSButton(
        checkboxWithTitle: "I understand and want this Mac to send the listed metadata to this Hub",
        target: nil,
        action: nil
    )
    private let deliveryCheckbox = NSButton(
        checkboxWithTitle: "Send observations to the enrolled Hub",
        target: nil,
        action: nil
    )
    private let destinationLabel = NSTextField(labelWithString: "Not enrolled")
    private let statusLabel = NSTextField(labelWithString: "Delivery is off")
    private let pendingLabel = NSTextField(labelWithString: "Pending: 0")
    private let oldestLabel = NSTextField(labelWithString: "Oldest pending: none")
    private let acknowledgedLabel = NSTextField(labelWithString: "Last acknowledged: never")

    init() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 650, height: 610),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "EgressView Hub Delivery"
        super.init(window: window)
        window.delegate = self
        buildContent()
        restore()
        startConnectivityMonitor()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    deinit {
        networkMonitor.cancel()
    }

    func show() {
        restore()
        showWindow(nil)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func enqueue(_ observations: [ConnectionObservation]) {
        guard preferences.isEnabled else { return }
        observationQueue.async { [weak self] in
            guard let self else { return }
            let sampled = self.deliverySampler.observationsToPersist(observations)
            guard !sampled.isEmpty else { return }
            Task { await self.sender?.enqueue(sampled) }
        }
    }

    private func makeSender() -> AgentIngestSender? {
        let queue: AgentDeliveryQueue
        do {
            queue = try AgentDeliveryQueue()
        } catch {
            statusLabel.stringValue = "Delivery unavailable: the private pending queue could not be opened"
            deliveryCheckbox.isEnabled = false
            return nil
        }
        let metadata = AgentIngestMetadata(
            hostName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            platform: .macOS,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        )
        return AgentIngestSender(
            queue: queue,
            credentialStore: credentialStore,
            metadata: metadata,
            statusHandler: { [weak self] state, queueStatus in
                DispatchQueue.main.async { self?.render(state: state, queueStatus: queueStatus) }
            }
        )
    }

    private func restore() {
        let credential = (try? credentialStore.load()) ?? nil
        let senderAvailable = sender != nil
        hubField.stringValue = credential?.hubURL.absoluteString ?? ""
        destinationLabel.stringValue = credential.map { "Enrolled Hub: \($0.hubURL.absoluteString)" }
            ?? "Not enrolled"
        deliveryCheckbox.state = preferences.isEnabled && credential != nil ? .on : .off
        deliveryCheckbox.isEnabled = credential != nil && senderAvailable
        Task {
            let status = await sender?.currentQueueStatus()
            if let status {
                await MainActor.run { self.render(state: senderState, queueStatus: status) }
            }
            await sender?.setEnabled(preferences.isEnabled && credential != nil && senderAvailable)
        }
    }

    private func startConnectivityMonitor() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            guard let sender = self?.sender else { return }
            Task { await sender.setConnectivityAvailable(path.status == .satisfied) }
        }
        networkMonitor.start(queue: networkQueue)
    }

    @objc private func enroll() {
        guard consentCheckbox.state == .on else {
            showError("Review the data summary and confirm consent before enrolling.")
            return
        }
        guard let hubURL = URL(string: hubField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            showError("Enter a valid Hub URL.")
            return
        }
        let code = codeField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        setControlsEnabled(false)
        let metadata = AgentEnrollmentMetadata(
            hostName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            platform: "macos",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        )
        Task {
            do {
                let credential = try await AgentEnrollmentService(
                    credentialStore: credentialStore
                ).enroll(hubURL: hubURL, code: code, metadata: metadata)
                await MainActor.run {
                    codeField.stringValue = ""
                    destinationLabel.stringValue = "Enrolled Hub: \(credential.hubURL.absoluteString)"
                    deliveryCheckbox.isEnabled = true
                    deliveryCheckbox.state = .off
                    preferences.isEnabled = false
                    setControlsEnabled(true)
                }
                await sender?.setEnabled(false)
            } catch {
                await MainActor.run {
                    setControlsEnabled(true)
                    showError("Enrollment failed. Check the Hub URL and one-time code.")
                }
            }
        }
    }

    @objc private func toggleDelivery() {
        let enabled = deliveryCheckbox.state == .on
        guard !enabled || consentCheckbox.state == .on else {
            deliveryCheckbox.state = .off
            showError("Confirm the delivery summary before enabling delivery.")
            return
        }
        preferences.isEnabled = enabled
        Task { await sender?.setEnabled(enabled) }
    }

    @objc private func sendNow() {
        Task { await sender?.sendNow() }
    }

    private func render(state: AgentIngestSenderState, queueStatus: AgentDeliveryQueueStatus) {
        senderState = state
        self.queueStatus = queueStatus
        statusLabel.stringValue = label(for: state)
        pendingLabel.stringValue = "Pending: \(queueStatus.pendingCount) · dropped at local limit: \(queueStatus.droppedCount)"
        oldestLabel.stringValue = "Oldest pending: \(format(queueStatus.oldestPendingAt, fallback: "none"))"
        acknowledgedLabel.stringValue = "Last acknowledged: \(format(queueStatus.lastAcknowledgedAt, fallback: "never"))"
    }

    private func label(for state: AgentIngestSenderState) -> String {
        switch state {
        case .off: return "Delivery is off"
        case .paused: return "Delivery is paused"
        case .waitingForNetwork: return "Waiting for a network path to the configured Hub"
        case .idle: return "Ready"
        case .sending: return "Sending a bounded batch..."
        case .retryScheduled(let date): return "Hub unavailable; next low-frequency retry \(format(date, fallback: ""))"
        case .authorizationRequired: return "Hub authorization expired or was revoked"
        case .failed(let message): return message
        }
    }

    private func format(_ date: Date?, fallback: String) -> String {
        guard let date else { return fallback }
        return DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .medium)
    }

    private func setControlsEnabled(_ enabled: Bool) {
        hubField.isEnabled = enabled
        codeField.isEnabled = enabled
        consentCheckbox.isEnabled = enabled
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Hub delivery"
        alert.informativeText = message
        alert.runModal()
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }
        let title = NSTextField(labelWithString: "Send to your EgressView Hub")
        title.font = .systemFont(ofSize: 23, weight: .semibold)
        let explanation = wrappingLabel(
            "This Mac initiates delivery only to the Hub you specify. The Hub never polls this Mac. " +
            "When the Hub cannot be reached, observations remain on this Mac and retries are bounded."
        )
        let sent = wrappingLabel(
            "Sent: host name, local/remote IP and port, protocol, process name and ID, bundle ID, " +
            "timestamps, byte counters, collector and confidence."
        )
        let notSent = wrappingLabel(
            "Never sent: packet payloads, credentials, command lines, account names, file paths, " +
            "browser URLs or browsing history."
        )
        sent.textColor = .secondaryLabelColor
        notSent.textColor = .secondaryLabelColor

        hubField.placeholderString = "https://hub.example"
        codeField.placeholderString = "One-time enrollment code"
        consentCheckbox.target = self
        deliveryCheckbox.target = self
        deliveryCheckbox.action = #selector(toggleDelivery)

        let enrollButton = NSButton(title: "Enroll this Mac", target: self, action: #selector(enroll))
        enrollButton.bezelStyle = .rounded
        let sendButton = NSButton(title: "Send now", target: self, action: #selector(sendNow))
        sendButton.bezelStyle = .rounded
        let actions = NSStackView(views: [enrollButton, sendButton, NSView()])
        actions.orientation = .horizontal
        actions.spacing = 10

        let stack = NSStackView(views: [
            title, explanation, separator(),
            NSTextField(labelWithString: "Hub URL"), hubField,
            NSTextField(labelWithString: "One-time enrollment code"), codeField,
            sent, notSent, consentCheckbox, actions,
            separator(), destinationLabel, deliveryCheckbox,
            statusLabel, pendingLabel, oldestLabel, acknowledgedLabel,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)
        hubField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        codeField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: contentView.bottomAnchor, constant: -22),
        ])
    }

    private func wrappingLabel(_ value: String) -> NSTextField {
        let label = NSTextField(wrappingLabelWithString: value)
        label.maximumNumberOfLines = 0
        return label
    }

    private func separator() -> NSBox {
        let box = NSBox()
        box.boxType = .separator
        return box
    }
}
