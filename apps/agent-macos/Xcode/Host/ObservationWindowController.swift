import AppKit
import EgressViewAgentCore
import SwiftUI

private enum AgentMainTab: String, CaseIterable, Identifiable {
    case status
    case analysis

    var id: String { rawValue }
    var title: String { self == .status ? L("Status") : L("Analysis") }
}

private enum AgentHistoryPeriod: String, CaseIterable, Identifiable {
    case hour
    case sixHours
    case day
    case week
    case month

    var id: String { rawValue }

    var title: String {
        switch self {
        case .hour: return L("Last hour")
        case .sixHours: return L("Last 6 hours")
        case .day: return L("Last 24 hours")
        case .week: return L("Last 7 days")
        case .month: return L("Last 30 days")
        }
    }

    var duration: TimeInterval {
        switch self {
        case .hour: return 3_600
        case .sixHours: return 6 * 3_600
        case .day: return 24 * 3_600
        case .week: return 7 * 86_400
        case .month: return 30 * 86_400
        }
    }
}

private struct AgentPeriodSummary: Equatable {
    var sessionCount = 0
    var applicationCount = 0
    var destinationCount = 0
}

private struct AgentObservationRow: Identifiable {
    let id: String
    let observation: ConnectionObservation
}

@MainActor
private final class AgentMainViewModel: ObservableObject {
    @Published var selectedTab = AgentMainTab.status
    @Published var period = AgentHistoryPeriod.hour {
        didSet { refresh() }
    }
    @Published private(set) var observationRows: [AgentObservationRow] = []
    @Published private(set) var summary = AgentPeriodSummary()
    @Published private(set) var storage: ObservationStoreStatistics?
    @Published private(set) var monitoringStatus = L("Monitoring paused")
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRefreshing = false

    private let store: ObservationStore?
    private let loadQueue = DispatchQueue(label: "com.egressview.agent.main-window")
    private var refreshTimer: Timer?

    init(store: ObservationStore?) {
        self.store = store
    }

    func start() {
        refresh()
        refreshTimer?.invalidate()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    func stop() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    func setMonitoringStatus(_ value: String) {
        monitoringStatus = value
    }

    func showStorageError(_ message: String) {
        errorMessage = message
    }

    func refresh() {
        guard let store else {
            errorMessage = L("Local history is unavailable because App Group access failed.")
            return
        }
        guard !isRefreshing else { return }
        isRefreshing = true
        let period = period
        loadQueue.async { [weak self] in
            let to = Date()
            let from = to.addingTimeInterval(-period.duration)
            let result = Result {
                let observations = try store.observations(since: from, limit: 500)
                let rollup = try store.hourlyRollup(from: from, to: to)
                let summary = AgentPeriodSummary(
                    sessionCount: rollup.reduce(0) { $0 + $1.sessionCount },
                    applicationCount: Set(rollup.map(\.processName)).count,
                    destinationCount: Set(rollup.map(\.remoteAddress)).count
                )
                return (observations, summary, try store.statistics())
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isRefreshing = false
                switch result {
                case .success(let value):
                    self.observationRows = value.0.enumerated().map { index, observation in
                        AgentObservationRow(
                            id: "\(observation.stableKey)|\(observation.lastObservedAt.timeIntervalSince1970)|\(index)",
                            observation: observation
                        )
                    }
                    self.summary = value.1
                    self.storage = value.2
                    self.errorMessage = nil
                case .failure(let error):
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }
}

private struct AgentMainView: View {
    @ObservedObject var model: AgentMainViewModel
    @ObservedObject private var language = AgentLanguageSettings.shared

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Group {
                if model.selectedTab == .status {
                    statusView
                } else {
                    analysisView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 760, minHeight: 500)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 18) {
            VStack(alignment: .leading, spacing: 2) {
                Text("EgressView Agent")
                    .font(.title2.weight(.semibold))
                Text(L("Outbound connections observed on this Mac"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Picker(L("View"), selection: $model.selectedTab) {
                ForEach(AgentMainTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 220)
            Picker(L("Period"), selection: $model.period) {
                ForEach(AgentHistoryPeriod.allCases) { period in
                    Text(period.title).tag(period)
                }
            }
            .frame(width: 150)
            Button {
                model.refresh()
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .help(L("Refresh"))
            .disabled(model.isRefreshing)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 16)
    }

    private var statusView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("Your network, right now"))
                        .font(.system(size: 34, weight: .bold, design: .rounded))
                    Text(L("A local summary for %@. Packet payloads are never collected.", model.period.title))
                        .foregroundStyle(.secondary)
                }

                HStack(spacing: 14) {
                    metricCard(title: L("Connections"), value: model.summary.sessionCount.formatted(), symbol: "point.3.connected.trianglepath.dotted")
                    metricCard(title: L("Applications"), value: model.summary.applicationCount.formatted(), symbol: "app.dashed")
                    metricCard(title: L("Destinations"), value: model.summary.destinationCount.formatted(), symbol: "network")
                }

                VStack(alignment: .leading, spacing: 10) {
                    Label(L("Collection"), systemImage: "waveform.path.ecg")
                        .font(.headline)
                    Text(model.monitoringStatus)
                        .font(.title3.weight(.medium))
                    if let storage = model.storage {
                        Text(storageDescription(storage))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(18)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))

                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.red)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
                }
            }
            .padding(24)
        }
    }

    private var analysisView: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Connection activity"))
                        .font(.title2.weight(.semibold))
                    Text(L("Showing the newest 500 records in the shared period"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(L("%lld shown", model.observationRows.count))
                    .foregroundStyle(.secondary)
            }
            Table(model.observationRows) {
                TableColumn(L("Observed")) { row in
                    Text(row.observation.lastObservedAt, style: .time)
                }
                .width(min: 90, ideal: 120)
                TableColumn(L("Application")) { row in
                    Text(row.observation.processName.isEmpty ? "PID \(row.observation.processID)" : row.observation.processName)
                }
                .width(min: 130, ideal: 180)
                TableColumn(L("Destination")) { row in
                    Text(destination(row.observation))
                        .monospaced()
                }
                .width(min: 220, ideal: 300)
                TableColumn(L("Protocol")) { row in
                    Text(row.observation.networkProtocol.rawValue.uppercased())
                }
                .width(70)
                TableColumn(L("Source")) { row in
                    Text(row.observation.collector == .networkExtension ? L("Network") : L("Lightweight"))
                }
                .width(100)
            }
        }
        .padding(22)
    }

    private func metricCard(title: String, value: String, symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(title, systemImage: symbol)
                .font(.callout.weight(.medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
                .contentTransition(.numericText())
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 14))
    }

    private func destination(_ observation: ConnectionObservation) -> String {
        let address = observation.remoteAddress.contains(":")
            ? "[\(observation.remoteAddress)]"
            : observation.remoteAddress
        return "\(address):\(observation.remotePort)"
    }

    private func storageDescription(_ statistics: ObservationStoreStatistics) -> String {
        let size = ByteCountFormatter.string(fromByteCount: statistics.fileSizeBytes, countStyle: .file)
        return L(
            "%lld recent records · %lld hourly totals · %@ on disk",
            statistics.rawCount,
            statistics.rolledUpCount,
            size
        )
    }
}

final class ObservationWindowController: NSWindowController, NSWindowDelegate {
    private static let retentionDefaultsKey = "localHistoryRetentionDays"

    static var configuredRetentionDays: Int {
        get {
            let value = UserDefaults.standard.integer(forKey: retentionDefaultsKey)
            return ObservationRetention.allowedRetentionDays.contains(value) ? value : 30
        }
        set {
            guard ObservationRetention.allowedRetentionDays.contains(newValue) else { return }
            UserDefaults.standard.set(newValue, forKey: retentionDefaultsKey)
        }
    }

    @MainActor private let model: AgentMainViewModel

    @MainActor
    init(store: ObservationStore?) {
        let model = AgentMainViewModel(store: store)
        self.model = model
        let hostingController = NSHostingController(rootView: AgentMainView(model: model))
        let window = NSWindow(contentViewController: hostingController)
        window.title = "EgressView Agent"
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 940, height: 620))
        window.minSize = NSSize(width: 760, height: 500)
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    @MainActor
    func show() {
        showWindow(nil)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
        model.start()
    }

    @MainActor
    func noteObservationsAvailable() {
        guard window?.isVisible == true else { return }
        model.refresh()
    }

    @MainActor
    func updateMonitoringStatus(_ status: AgentMonitoringStatus) {
        model.setMonitoringStatus(status.label)
    }

    @MainActor
    func showStorageError(_ message: String) {
        model.showStorageError(message)
    }

    @MainActor
    func windowWillClose(_ notification: Notification) {
        model.stop()
    }
}
