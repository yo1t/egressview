import AppKit
import EgressViewAgentCore

final class ObservationWindowController: NSWindowController, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate {
    private static let retentionDefaultsKey = "localHistoryRetentionDays"

    static var configuredRetentionDays: Int {
        UserDefaults.standard.integer(forKey: retentionDefaultsKey)
    }

    private enum Column: String, CaseIterable {
        case observed = "Observed"
        case application = "Application"
        case destination = "Destination"
        case networkProtocol = "Protocol"
        case collector = "Source"

        var width: CGFloat {
            switch self {
            case .observed: return 145
            case .application: return 180
            case .destination: return 285
            case .networkProtocol: return 80
            case .collector: return 110
            }
        }
    }

    private let journal: ObservationJournal?
    private let loadQueue = DispatchQueue(label: "com.egressview.agent.observation-ui")
    private var observations: [ConnectionObservation] = []
    private var refreshTimer: Timer?
    private var isRefreshing = false
    private var isMutating = false
    private let tableView = NSTableView()
    private let summaryLabel = NSTextField(labelWithString: "No observations yet")
    private let storageLabel = NSTextField(labelWithString: "Storage: calculating...")
    private let errorLabel = NSTextField(labelWithString: "")
    private let retentionPopUp = NSPopUpButton()
    private lazy var deleteButton = NSButton(title: "Delete History...", target: self, action: #selector(deleteHistory))
    private lazy var dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter
    }()

    init(journal: ObservationJournal?) {
        self.journal = journal
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 900, height: 570),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "EgressView Connection Activity"
        window.minSize = NSSize(width: 720, height: 380)
        super.init(window: window)
        window.delegate = self
        buildContent()
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        showWindow(nil)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        refresh()
        startRefreshTimer()
    }

    func noteObservationsAvailable() {
        guard window?.isVisible == true else { return }
        refresh()
    }

    func showStorageError(_ message: String) {
        errorLabel.stringValue = "Local history unavailable: \(message)"
        errorLabel.isHidden = false
    }

    func numberOfRows(in tableView: NSTableView) -> Int {
        observations.count
    }

    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard row < observations.count,
              let identifier = tableColumn?.identifier,
              let column = Column(rawValue: identifier.rawValue) else {
            return nil
        }
        let cell = tableView.makeView(withIdentifier: identifier, owner: self) as? NSTableCellView
            ?? makeCell(identifier: identifier)
        let observation = observations[row]
        cell.textField?.stringValue = value(for: column, observation: observation)
        cell.textField?.toolTip = cell.textField?.stringValue
        return cell
    }

    func windowWillClose(_ notification: Notification) {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    @objc private func refresh() {
        guard let journal else {
            showStorageError("App Group access is not available")
            return
        }
        guard !isRefreshing else { return }
        isRefreshing = true
        loadQueue.async { [weak self] in
            let result = Result { try journal.snapshot(limit: 500) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isRefreshing = false
                switch result {
                case .success(let snapshot):
                    self.observations = snapshot.observations
                    self.tableView.reloadData()
                    self.summaryLabel.stringValue = snapshot.observations.isEmpty
                        ? "No observations yet. Start Lightweight or Full monitoring."
                        : "\(snapshot.observations.count) recent connections · newest first"
                    self.storageLabel.stringValue = self.storageSummary(snapshot.statistics)
                    self.errorLabel.isHidden = true
                case .failure(let error):
                    self.showStorageError(error.localizedDescription)
                }
            }
        }
    }

    private func buildContent() {
        guard let contentView = window?.contentView else { return }

        let title = NSTextField(labelWithString: "Connection activity")
        title.font = .systemFont(ofSize: 24, weight: .semibold)
        let privacy = NSTextField(labelWithString: "Stored locally on this Mac · payloads are never collected")
        privacy.textColor = .secondaryLabelColor
        let refreshButton = NSButton(title: "Refresh", target: self, action: #selector(refresh))
        refreshButton.bezelStyle = .rounded

        let heading = NSStackView()
        heading.orientation = .horizontal
        heading.alignment = .centerY
        heading.spacing = 12
        heading.addView(title, in: .leading)
        heading.addView(refreshButton, in: .trailing)

        errorLabel.textColor = .systemRed
        errorLabel.isHidden = true
        storageLabel.textColor = .secondaryLabelColor

        configureRetentionPopUp()
        let retentionLabel = NSTextField(labelWithString: "Keep history:")
        let historyControls = NSStackView()
        historyControls.orientation = .horizontal
        historyControls.alignment = .centerY
        historyControls.spacing = 8
        historyControls.addView(retentionLabel, in: .leading)
        historyControls.addView(retentionPopUp, in: .leading)
        historyControls.addView(deleteButton, in: .trailing)
        deleteButton.bezelStyle = .rounded
        deleteButton.toolTip = "Delete local connection metadata without changing monitoring"

        for column in Column.allCases {
            let tableColumn = NSTableColumn(identifier: NSUserInterfaceItemIdentifier(column.rawValue))
            tableColumn.title = column.rawValue
            tableColumn.width = column.width
            tableColumn.minWidth = min(70, column.width)
            tableView.addTableColumn(tableColumn)
        }
        tableView.delegate = self
        tableView.dataSource = self
        tableView.usesAlternatingRowBackgroundColors = true
        tableView.rowHeight = 28
        tableView.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle

        let scrollView = NSScrollView()
        scrollView.documentView = tableView
        scrollView.hasVerticalScroller = true
        scrollView.borderType = .bezelBorder

        let stack = NSStackView(views: [heading, privacy, historyControls, summaryLabel, storageLabel, errorLabel, scrollView])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 10
        stack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(stack)

        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 22),
            stack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -22),
            stack.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 20),
            stack.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -20),
            heading.widthAnchor.constraint(equalTo: stack.widthAnchor),
            historyControls.widthAnchor.constraint(equalTo: stack.widthAnchor),
            scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
        ])
    }

    private func makeCell(identifier: NSUserInterfaceItemIdentifier) -> NSTableCellView {
        let cell = NSTableCellView()
        cell.identifier = identifier
        let label = NSTextField(labelWithString: "")
        label.lineBreakMode = .byTruncatingMiddle
        label.translatesAutoresizingMaskIntoConstraints = false
        cell.textField = label
        cell.addSubview(label)
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 6),
            label.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -6),
            label.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
        ])
        return cell
    }

    private func value(for column: Column, observation: ConnectionObservation) -> String {
        switch column {
        case .observed:
            return dateFormatter.string(from: observation.lastObservedAt)
        case .application:
            return observation.processName.isEmpty ? "PID \(observation.processID)" : observation.processName
        case .destination:
            let address = observation.remoteAddress.contains(":")
                ? "[\(observation.remoteAddress)]"
                : observation.remoteAddress
            return "\(address):\(observation.remotePort)"
        case .networkProtocol:
            return observation.networkProtocol.rawValue.uppercased()
        case .collector:
            return observation.collector == .networkExtension ? "Full" : "Lightweight"
        }
    }

    private func startRefreshTimer() {
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            self?.refresh()
        }
    }

    private var retentionDays: Int {
        Self.configuredRetentionDays
    }

    private func configureRetentionPopUp() {
        let choices = [
            ("Until storage limit", 0),
            ("1 day", 1),
            ("7 days", 7),
            ("30 days", 30),
            ("90 days", 90),
        ]
        for choice in choices {
            retentionPopUp.addItem(withTitle: choice.0)
            retentionPopUp.lastItem?.tag = choice.1
        }
        retentionPopUp.target = self
        retentionPopUp.action = #selector(changeRetention)
        selectRetention(days: retentionDays)
    }

    @objc private func changeRetention() {
        let requestedDays = retentionPopUp.selectedTag()
        let previousDays = retentionDays
        guard requestedDays != previousDays else { return }
        guard requestedDays > 0 else {
            UserDefaults.standard.set(0, forKey: Self.retentionDefaultsKey)
            return
        }

        let alert = NSAlert()
        alert.messageText = "Keep local history for \(requestedDays) days?"
        alert.informativeText = "Older connection metadata will be deleted now and on future launches. Monitoring will continue."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Apply and Delete Older History")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else {
            selectRetention(days: previousDays)
            return
        }

        runMutation(
            operation: { [journal] in
                guard let journal else { return }
                let cutoff = Calendar.current.date(byAdding: .day, value: -requestedDays, to: Date()) ?? Date()
                try journal.removeObservations(before: cutoff)
            },
            onSuccess: {
                UserDefaults.standard.set(requestedDays, forKey: Self.retentionDefaultsKey)
            },
            onFailure: { [weak self] in self?.selectRetention(days: previousDays) }
        )
    }

    @objc private func deleteHistory() {
        let alert = NSAlert()
        alert.messageText = "Delete all local connection history?"
        alert.informativeText = "This cannot be undone. Monitoring will continue and new observations may appear immediately."
        alert.alertStyle = .critical
        alert.addButton(withTitle: "Delete History")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        runMutation(operation: { [journal] in
            try journal?.removeAll()
        })
    }

    private func runMutation(
        operation: @escaping @Sendable () throws -> Void,
        onSuccess: @escaping () -> Void = {},
        onFailure: @escaping () -> Void = {}
    ) {
        guard !isMutating else { return }
        isMutating = true
        retentionPopUp.isEnabled = false
        deleteButton.isEnabled = false
        loadQueue.async { [weak self] in
            let result = Result { try operation() }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isMutating = false
                self.retentionPopUp.isEnabled = true
                self.deleteButton.isEnabled = true
                switch result {
                case .success:
                    onSuccess()
                    self.refresh()
                case .failure(let error):
                    onFailure()
                    self.showStorageError(error.localizedDescription)
                }
            }
        }
    }

    private func selectRetention(days: Int) {
        let index = retentionPopUp.indexOfItem(withTag: days)
        retentionPopUp.selectItem(at: index >= 0 ? index : 0)
    }

    private func storageSummary(_ statistics: ObservationJournalStatistics) -> String {
        let bytes = ByteCountFormatter.string(fromByteCount: Int64(statistics.storedBytes), countStyle: .file)
        let maximum = ByteCountFormatter.string(fromByteCount: Int64(statistics.maximumStoredBytes), countStyle: .file)
        guard let oldest = statistics.oldestObservationAt,
              let newest = statistics.newestObservationAt else {
            return "Storage: \(bytes) of \(maximum) · 0 records"
        }
        return "Storage: \(bytes) of \(maximum) · \(statistics.recordCount) records · \(dateFormatter.string(from: oldest)) – \(dateFormatter.string(from: newest))"
    }
}
