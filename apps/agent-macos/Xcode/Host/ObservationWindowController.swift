import AppKit
import EgressViewAgentCore
import SwiftUI

private enum AgentMainTab: String, CaseIterable, Identifiable {
    /// What is happening on the network, and whether the agent is in a state to
    /// know. These were two tabs, and separating them meant the charts could be
    /// read without ever seeing that collection had stopped -- which is exactly
    /// how an outage went unnoticed for hours.
    case network
    /// Its own tab. The log wants the whole window -- rows are long and there
    /// are hundreds of them -- and sharing the screen with the charts left both
    /// too short to read.
    case log

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return L("Network status")
        case .log: return L("Connection log")
        }
    }
}

// The period lives in `VisualizationSelection` so the table, the timeline and
// the sankey cannot drift apart. Three views each holding their own window
// would make "which app caused that spike, and where was it going"
// unanswerable.
extension TimeScale: @retroactive Identifiable {
    public var id: String { rawValue }

    var title: String {
        switch self {
        case .hour: return L("Last hour")
        case .sixHours: return L("Last 6 hours")
        case .day: return L("Last 24 hours")
        case .week: return L("Last 7 days")
        case .month: return L("Last 30 days")
        }
    }
}

extension DestinationGrouping: @retroactive Identifiable {
    public var id: String { rawValue }

    var title: String {
        self == .name ? L("Name") : L("IP address")
    }
}

extension TrafficMetric: @retroactive Identifiable {
    public var id: String { rawValue }

    var title: String {
        self == .sessions ? L("Connections") : L("Data volume")
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
    @Published var selectedTab = AgentMainTab.network
    @Published var scale = TimeScale.hour {
        didSet { refresh() }
    }
    @Published var metric = TrafficMetric.sessions {
        didSet { refresh() }
    }
    @Published var destinationGrouping = DestinationGrouping.name {
        didSet { refresh() }
    }
    @Published private(set) var availableMetrics: [TrafficMetric] = [.sessions]
    @Published private(set) var sankey = SankeyAggregator().aggregate([], metric: .sessions)
    @Published private(set) var globe = GlobeAggregator().aggregate(
        placed: [], unplacedSessions: 0, unplacedBytes: 0, metric: .sessions, hasLocationData: false
    )
    /// Loaded once. The outlines never change, and re-reading 100 KB on every
    /// refresh would spend the user's battery on a constant.
    let atlas = try? WorldAtlas.bundled()
    @Published private(set) var timeline = TimelineAggregator().aggregate(
        [], selection: VisualizationSelection()
    )
    @Published private(set) var observationRows: [AgentObservationRow] = []
    @Published private(set) var summary = AgentPeriodSummary()
    @Published private(set) var coverage = CoverageSummary(
        share: 1, firstCovered: nil, gaps: [], startedInsidePeriod: false
    )
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

    /// Writes the selected period to a CSV file the user picks.
    ///
    /// Exports the whole period, not the 500 rows the table shows: the table is
    /// capped so the window stays responsive, and silently exporting only what
    /// happened to be on screen would produce a file that looks complete and is
    /// not.
    func exportCSV() {
        guard let store else {
            errorMessage = L("Local history is unavailable because App Group access failed.")
            return
        }
        let selection = VisualizationSelection(scale: scale, metric: metric, end: Date())
        let panel = NSSavePanel()
        panel.nameFieldStringValue = ObservationCSV.suggestedFileName(
            from: selection.start, to: selection.end
        )
        panel.allowedContentTypes = [.commaSeparatedText]
        panel.message = coverage.isComplete
            ? L("Exports every connection recorded in the selected period.")
            : L("This period was only %lld%% monitored. The file contains what was recorded, which is less than everything that happened.",
                Int((coverage.share * 100).rounded()))
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let observations = try store.observations(
                since: selection.start, limit: Int.max
            ).filter { $0.lastObservedAt <= selection.end }
            try ObservationCSV.export(observations)
                .write(to: url, atomically: true, encoding: .utf8)
            errorMessage = nil
        } catch {
            errorMessage = L("Could not write the file: %@", error.localizedDescription)
        }
    }

    func refresh() {
        guard let store else {
            errorMessage = L("Local history is unavailable because App Group access failed.")
            return
        }
        guard !isRefreshing else { return }
        isRefreshing = true
        let selection = VisualizationSelection(scale: scale, metric: metric, end: Date())
        let grouping = destinationGrouping
        loadQueue.async { [weak self] in
            let from = selection.start
            let to = selection.end
            let result = Result {
                let observations = try store.observations(since: from, limit: 500)
                let rollup = try store.hourlyRollup(from: from, to: to)
                let summary = AgentPeriodSummary(
                    sessionCount: rollup.reduce(0) { $0 + $1.sessionCount },
                    applicationCount: Set(rollup.map(\.processName)).count,
                    destinationCount: Set(rollup.map(\.remoteAddress)).count
                )
                let pairs = try store.appDestinationTotals(from: from, to: to, grouping: grouping)
                let buckets = try store.appTimeline(
                    from: from, to: to, buckets: VisualizationSelection.bucketCount
                )
                // The byte view is offered only once something has actually
                // been measured; otherwise every bar would be empty.
                let measuredBytes = pairs.contains { $0.bytes > 0 }
                let coverage = CoverageCalculator.summarize(
                    sessions: try store.coverageSessions(from: from, to: to), from: from, to: to
                )
                let locations = try store.destinationLocations(from: from, to: to)
                let globe = GlobeAggregator().aggregate(
                    placed: locations.placed,
                    unplacedSessions: locations.unplacedSessions,
                    unplacedBytes: locations.unplacedBytes,
                    metric: selection.metric,
                    hasLocationData: try store.geoLocationCount() > 0
                )
                return (
                    observations, summary, try store.statistics(),
                    SankeyAggregator().aggregate(pairs, metric: selection.metric),
                    TimelineAggregator().aggregate(buckets, selection: selection),
                    measuredBytes, globe, coverage
                )
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isRefreshing = false
                switch result {
                case .success(let value):
                    self.sankey = value.3
                    self.timeline = value.4
                    self.globe = value.6
                    self.coverage = value.7
                    self.availableMetrics = VisualizationSelection.availableMetrics(
                        hasMeasuredBytes: value.5
                    )
                    if !self.availableMetrics.contains(self.metric) {
                        self.metric = .sessions
                    }
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
                switch model.selectedTab {
                case .network: analysisView
                case .log: logView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 900, minHeight: 620)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var header: some View {
        HStack(spacing: 18) {
            Image(nsImage: NSApplication.shared.applicationIconImage)
                .resizable()
                .interpolation(.high)
                .frame(width: 34, height: 34)
                .accessibilityHidden(true)
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
            .frame(width: 320)
            Picker(L("Period"), selection: $model.scale) {
                ForEach(TimeScale.allCases) { scale in
                    Text(scale.title).tag(scale)
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

    private var analysisView: some View {
        VStack(spacing: 0) {
            analysisControls
            errorBanner
            GeometryReader { proxy in
                let metrics = AnalysisLayout(size: proxy.size)
                VStack(spacing: 14) {
                    HStack(alignment: .top, spacing: 14) {
                        AgentGlobeChart(model: model.globe, atlas: model.atlas)
                            .frame(width: metrics.globeWidth, height: metrics.topHeight)
                        AgentOverviewPanel(
                            summary: model.summary,
                            coverage: model.coverage,
                            monitoringStatus: model.monitoringStatus,
                            storage: model.storage
                        )
                        .frame(maxWidth: .infinity)
                        .frame(height: metrics.topHeight)
                    }
                    // One HStack, one height: the sankey and the timeline line
                    // up top and bottom at every window size because they are
                    // given the same box, not because two numbers happen to
                    // agree.
                    HStack(alignment: .top, spacing: 14) {
                        AgentSankeyChart(model: model.sankey)
                            .frame(width: metrics.sankeyWidth)
                        AgentTimelineChart(model: model.timeline, scale: model.scale)
                            .frame(maxWidth: .infinity)
                    }
                    .frame(height: metrics.middleHeight)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
            }
        }
    }

    private var logView: some View {
        VStack(spacing: 0) {
            analysisControls
            errorBanner
            connectionTable
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var errorBanner: some View {
        if let error = model.errorMessage {
            Label(error, systemImage: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.red.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
        }
    }

    private var analysisControls: some View {
        HStack(spacing: 16) {
            metricPicker
            destinationGroupingPicker
            Spacer()
            Button {
                model.exportCSV()
            } label: {
                Label(L("Export CSV..."), systemImage: "square.and.arrow.up")
            }
            .help(L("Saves every connection in the selected period as a CSV file"))
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
        .padding(.bottom, 10)
    }

    /// Proportions for the analysis tab, derived from the window rather than
    /// fixed, so the panels grow with it instead of leaving the extra space
    /// blank or forcing the log off the bottom.
    private struct AnalysisLayout {
        let topHeight: CGFloat
        let middleHeight: CGFloat
        let globeWidth: CGFloat
        let sankeyWidth: CGFloat

        init(size: CGSize) {
            let width = max(size.width, 1)
            // Spacing comes off the top before anything is shared out, so the
            // rows can never add up to more than the window holds. Proportions
            // with no lower bound: a minimum would keep the top row's size on a
            // short window and squeeze the row below it to nothing.
            let height = max(size.height - 32, 1)
            topHeight = height * 0.52
            middleHeight = height * 0.48
            // Square. The controls are overlaid on the sphere rather than
            // stacked under it, so the extra width a landscape card bought is
            // no longer paying for anything.
            globeWidth = min(topHeight, width * 0.5)
            // The name columns either side are a fixed width, so narrowing the
            // card takes width off the diagram and not off the names -- which
            // is the intent: the ribbons had more room than they needed once
            // the names moved out of the canvas.
            sankeyWidth = min(max(width * 0.48, 336), width - 340)
        }
    }

    @ViewBuilder
    private var metricPicker: some View {
        // Offered only when both views can say something. A picker whose other
        // option is always blank is worse than no picker.
        if model.availableMetrics.count > 1 {
            Picker(L("Measure"), selection: $model.metric) {
                ForEach(model.availableMetrics) { metric in
                    Text(metric.title).tag(metric)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 300)
        }
    }

    private var destinationGroupingPicker: some View {
        Picker(L("Destinations by"), selection: $model.destinationGrouping) {
            ForEach(DestinationGrouping.allCases) { grouping in
                Text(grouping.title).tag(grouping)
            }
        }
        .pickerStyle(.segmented)
        .frame(width: 300)
        .help(L("A name groups a service together; an address shows how far its traffic is spread."))
    }

    private var connectionTable: some View {
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
            .frame(maxHeight: .infinity)
        }
        .padding(16)
        .agentSection()
    }

    private func destination(_ observation: ConnectionObservation) -> String {
        let address = observation.remoteAddress.contains(":")
            ? "[\(observation.remoteAddress)]"
            : observation.remoteAddress
        return "\(address):\(observation.remotePort)"
    }
}

// MARK: - Charts

private func formattedMetric(_ value: Double, _ metric: TrafficMetric) -> String {
    switch metric {
    case .sessions:
        return Int(value).formatted()
    case .bytes:
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }
}

/// Says which parts of the period nobody was watching.
///
/// Without this, the charts below present an unwatched hour and a quiet hour
/// identically, and the reader takes the empty chart as evidence that nothing
/// happened -- the one conclusion the data cannot support.
private struct AgentCoverageNote: View {
    let coverage: CoverageSummary

    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .none
        formatter.timeStyle = .short
        return formatter
    }()

    private static func duration(_ seconds: TimeInterval) -> String {
        let formatter = DateComponentsFormatter()
        formatter.allowedUnits = seconds >= 3600 ? [.hour, .minute] : [.minute]
        formatter.unitsStyle = .short
        formatter.maximumUnitCount = 2
        return formatter.string(from: max(60, seconds)) ?? ""
    }

    var body: some View {
        if !coverage.isComplete {
            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline).fontWeight(.medium)
                    if let detail {
                        Text(detail)
                    }
                }
            } icon: {
                Image(systemName: coverage.isEmpty ? "exclamationmark.triangle" : "clock.badge.questionmark")
            }
            .font(.callout)
            .foregroundStyle(coverage.isEmpty ? Color.orange : Color.secondary)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.orange.opacity(coverage.isEmpty ? 0.12 : 0.07))
            )
        }
    }

    private var headline: String {
        if coverage.isEmpty {
            return L("Nothing in this period was monitored. The charts below are empty because there is no record, not because there was no traffic.")
        }
        return L("Only %lld%% of this period was monitored. Anything outside that is missing from the charts below, not absent from the network.",
                 Int((coverage.share * 100).rounded()))
    }

    private var detail: String? {
        var parts: [String] = []
        if let first = coverage.firstCovered, coverage.startedInsidePeriod {
            parts.append(L("Monitoring started at %@. Connections already open at that moment were never seen.",
                           Self.clock.string(from: first)))
        }
        if let longest = coverage.gaps.first {
            parts.append(L("Longest unmonitored stretch: %1$@ from %2$@.",
                           Self.duration(longest.duration),
                           Self.clock.string(from: longest.start)))
        }
        return parts.isEmpty ? nil : parts.joined(separator: " ")
    }
}

/// Says what the chart cannot show, rather than letting the gaps read as quiet.
private struct AgentPartialCoverageNote: View {
    let count: Int

    var body: some View {
        Label(
            L("%lld connections have no byte count yet. Data volume is measured when a connection ends, so anything still open is not included.", count),
            systemImage: "info.circle"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// The rounded frame every section sits in.
///
/// One shape and one border for all of them: panels that each invent their own
/// corner and edge read as separate apps stitched together rather than as one
/// window.
private struct AgentSectionBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
            )
    }
}

private extension View {
    func agentSection() -> some View { modifier(AgentSectionBackground()) }
}

private struct AgentChartCard<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.title3.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            // No Spacer here. `content` is told to fill the card, and a Spacer
            // competing for the same space collapsed the sankey canvas to
            // nothing -- the chart vanished with no error, again.
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .agentSection()
    }
}

/// The top-right panel: how much was seen, and how much of it can be trusted.
private struct AgentOverviewPanel: View {
    let summary: AgentPeriodSummary
    let coverage: CoverageSummary
    let monitoringStatus: String
    let storage: ObservationStoreStatistics?

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("This period at a glance"))
                .font(.title3.weight(.semibold))

            // Collection state sits with the numbers it produced. It used to
            // live on a separate tab, which meant the charts could be read
            // without ever seeing that collection had stopped.
            VStack(alignment: .leading, spacing: 4) {
                Label(monitoringStatus, systemImage: "dot.radiowaves.left.and.right")
                    .font(.callout.weight(.medium))
                    .fixedSize(horizontal: false, vertical: true)
                if let storage {
                    Text(storageDescription(storage))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            // Coverage sits with the counts, not below the charts, because it
            // is what tells the reader whether the counts mean anything.
            AgentCoverageNote(coverage: coverage)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 130), spacing: 10)],
                alignment: .leading,
                spacing: 10
            ) {
                tile(L("Connections"), summary.sessionCount.formatted(),
                     "point.3.connected.trianglepath.dotted")
                tile(L("Applications"), summary.applicationCount.formatted(), "app.dashed")
                tile(L("Destinations"), summary.destinationCount.formatted(), "network")
                tile(L("Monitored"), "\(Int((coverage.share * 100).rounded()))%", "clock.badge.checkmark")
            }

            Spacer(minLength: 0)

            // No threat intelligence here on purpose. This agent classifies
            // nothing on its own, and a panel that looked like a verdict would
            // be inventing one.
            VStack(alignment: .leading, spacing: 5) {
                Label(
                    L("Packet contents are never collected."),
                    systemImage: "lock"
                )
                Label(
                    L("Threat classification comes from a Hub. This agent reports what it saw and judges none of it."),
                    systemImage: "info.circle"
                )
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .agentSection()
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

    private func tile(_ title: String, _ value: String, _ symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(title, systemImage: symbol)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Text(value)
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                .contentTransition(.numericText())
                .lineLimit(1)
                .minimumScaleFactor(0.6)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(0.05))
        )
    }
}

private let agentSeriesPalette: [Color] = [
    .blue, .teal, .indigo, .orange, .pink, .mint, .purple, .brown,
]

private func agentSeriesColor(_ index: Int, isRemainder: Bool) -> Color {
    // The remainder is deliberately grey: it is a residue, not a participant,
    // and colouring it like one invites reading it as a single application.
    isRemainder ? Color.secondary.opacity(0.45)
        : agentSeriesPalette[index % agentSeriesPalette.count]
}

private struct AgentTimelineChart: View {
    let model: TimelineModel
    let scale: TimeScale

    var body: some View {
        AgentChartCard(
            title: L("When traffic happened"),
            subtitle: L("Stacked by application, %@", scale.title)
        ) {
            if model.isEmpty {
                AgentEmptyChartNote(
                    text: model.byteCoverageIsPartial
                        ? L("No data volume has been measured in this period yet.")
                        : L("No connections in this period.")
                )
            } else {
                Canvas { context, size in draw(in: &context, size: size) }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityElement()
                    .accessibilityLabel(summary)
                AgentSeriesLegend(entries: model.series.enumerated().map {
                    .init(name: $0.element.name, color: agentSeriesColor($0.offset, isRemainder: $0.element.isRemainder))
                })
            }
            if model.byteCoverageIsPartial {
                AgentPartialCoverageNote(count: model.observationsWithoutBytes)
            }
        }
    }

    private var summary: String {
        model.accessibilitySummary(
            empty: L("No connections in this period."),
            headline: { count, total, metric in
                L("%1$lld applications, %2$@ in total.", count, formattedMetric(total, metric))
            },
            busiest: { app, share, _ in L("%1$@ accounts for %2$lld percent.", app, share) }
        )
    }

    /// Room for the axis labels. Without them the chart shows a shape but no
    /// magnitude, and "is this a lot?" has no answer.
    private let yAxisWidth: CGFloat = 56
    private let xAxisHeight: CGFloat = 18

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let peak = model.bucketTotals.max() ?? 0
        guard peak > 0, model.bucketStarts.count > 1 else { return }
        let plot = CGRect(
            x: yAxisWidth, y: 0,
            width: max(1, size.width - yAxisWidth),
            height: max(1, size.height - xAxisHeight)
        )
        let step = plot.width / CGFloat(model.bucketStarts.count)
        var baselines = [CGFloat](repeating: plot.maxY, count: model.bucketStarts.count)

        // Gridlines and the values they stand for.
        for fraction in [0.0, 0.5, 1.0] {
            let y = plot.maxY - plot.height * fraction
            var line = Path()
            line.move(to: CGPoint(x: plot.minX, y: y))
            line.addLine(to: CGPoint(x: plot.maxX, y: y))
            context.stroke(line, with: .color(.secondary.opacity(0.18)), lineWidth: 1)
            let label = Text(formattedMetric(peak * fraction, model.metric))
                .font(.system(size: 9))
                .foregroundColor(.secondary)
            context.draw(label, at: CGPoint(x: yAxisWidth - 6, y: y), anchor: .trailing)
        }

        for (index, series) in model.series.enumerated() {
            var path = Path()
            for bucket in model.bucketStarts.indices {
                let value = series.values.indices.contains(bucket) ? series.values[bucket] : 0
                guard value > 0 else { continue }
                let height = plot.height * CGFloat(value / peak)
                let top = baselines[bucket] - height
                path.addRect(CGRect(
                    x: plot.minX + CGFloat(bucket) * step, y: top,
                    width: max(1, step - 1), height: height
                ))
                baselines[bucket] = top
            }
            context.fill(path, with: .color(agentSeriesColor(index, isRemainder: series.isRemainder)))
        }

        // Times along the bottom. Three is enough to read the span without
        // crowding the narrow scales.
        let formatter = DateFormatter()
        formatter.locale = Locale.current
        formatter.dateFormat = scale == .week || scale == .month ? "M/d" : "H:mm"
        let last = model.bucketStarts.count - 1
        for (position, bucket) in [(0, 0), (1, last / 2), (2, last)] {
            guard model.bucketStarts.indices.contains(bucket) else { continue }
            let x = plot.minX + step * (CGFloat(bucket) + 0.5)
            let label = Text(formatter.string(from: model.bucketStarts[bucket]))
                .font(.system(size: 9))
                .foregroundColor(.secondary)
            let anchor: UnitPoint = position == 0 ? .leading : (position == 2 ? .trailing : .center)
            let clamped = position == 0 ? plot.minX : (position == 2 ? plot.maxX : x)
            context.draw(label, at: CGPoint(x: clamped, y: plot.maxY + xAxisHeight / 2), anchor: anchor)
        }
    }
}


private struct AgentGlobeChart: View {
    let model: GlobeModel
    let atlas: WorldAtlas?

    /// How fast the globe turns, if it turns at all.
    ///
    /// A still globe hides half the destinations behind it with no sign that
    /// they are there, so it turns by default. But rotation also makes a place
    /// hard to read while it moves, so it can be stopped and slowed.
    enum SpinSpeed: String, CaseIterable, Identifiable {
        case slow, normal, fast
        var id: String { rawValue }

        /// Degrees of longitude per second.
        var degreesPerSecond: Double {
            switch self {
            case .slow: return 2
            case .normal: return 6
            case .fast: return 16
            }
        }

        var title: String {
            switch self {
            case .slow: return L("Slow")
            case .normal: return L("Normal")
            case .fast: return L("Fast")
            }
        }
    }

    /// Rotation is a function of time, not something accumulated frame by
    /// frame. Adding to a `@State` from inside the `Canvas` renderer changes
    /// state during a view update, which SwiftUI is free to discard -- and did:
    /// the globe stayed still. `baseSpin` is the angle at `anchor`, and every
    /// frame derives its angle from the clock instead.
    @State private var baseSpin: Double = 0
    @State private var anchor = Date()
    @State private var speed: SpinSpeed = .normal
    @State private var isRunning = true
    @State private var tilt: Double = -12
    @State private var isDragging = false
    @State private var resumeAt = Date.distantPast

    private var isTurning: Bool { isRunning && !isDragging }

    private func spin(at date: Date) -> Double {
        guard isTurning else { return baseSpin }
        let elapsed = date.timeIntervalSince(max(anchor, resumeAt))
        return baseSpin + max(0, elapsed) * speed.degreesPerSecond
    }

    /// Pins the current angle before something changes what "current" means,
    /// so stopping, starting, changing speed and dragging never make the globe
    /// jump.
    private func freeze(at date: Date = Date()) {
        baseSpin = spin(at: date)
        anchor = date
    }

    private var spinControls: some View {
        HStack(spacing: 10) {
            Button {
                freeze()
                isRunning.toggle()
                resumeAt = .distantPast
            } label: {
                Label(
                    isRunning ? L("Stop") : L("Rotate"),
                    systemImage: isRunning ? "pause.fill" : "play.fill"
                )
            }
            .help(isRunning
                  ? L("Stop the globe where it is")
                  : L("Turn the globe so the far side comes round"))

            Picker(L("Speed"), selection: Binding(
                get: { speed },
                set: { newValue in
                    freeze()
                    resumeAt = .distantPast
                    speed = newValue
                }
            )) {
                ForEach(SpinSpeed.allCases) { value in
                    Text(value.title).tag(value)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 170)
            .disabled(!isRunning)
        }
        .font(.caption)
        .controlSize(.small)
    }

    private var home: (latitude: Double, longitude: Double) { HomeLocation.current() }

    var body: some View {
        AgentChartCard(
            title: L("Where the traffic went"),
            subtitle: model.metric == .bytes
                ? L("Mark size is data volume")
                : L("Mark size is the number of connections")
        ) {
            if let unavailable = model.unavailable {
                AgentEmptyChartNote(text: message(for: unavailable))
            } else {
                TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: !isTurning)) { context in
                    Canvas { canvas, size in
                        draw(in: &canvas, size: size, spin: spin(at: context.date))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            if !isDragging {
                                freeze()
                                isDragging = true
                            }
                            baseSpin += value.translation.width * 0.02
                            tilt = max(-80, min(80, tilt - value.translation.height * 0.02))
                        }
                        .onEnded { _ in
                            isDragging = false
                            anchor = Date()
                            // The same pause the Hub uses: let the user look at
                            // what they turned to before it moves again.
                            resumeAt = anchor.addingTimeInterval(2.5)
                        }
                )
                .overlay(alignment: .bottomTrailing) {
                    // Overlaid rather than stacked below: the globe is drawn
                    // from the smaller side of its box, so every point of
                    // height the controls took came straight off the sphere.
                    spinControls
                        .padding(8)
                        .background(
                            RoundedRectangle(cornerRadius: 9, style: .continuous)
                                .fill(.thinMaterial)
                        )
                        .padding(6)
                }
                .accessibilityElement()
                .accessibilityLabel(summary)
            }
            if model.coverageIsPartial {
                Label(
                    L("%lld%% of this period could be placed. The rest has no known location.",
                      Int((model.placedShare * 100).rounded())),
                    systemImage: "info.circle"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
        }
    }

    private func message(for reason: GlobeUnavailableReason) -> String {
        switch reason {
        case .noLocationData:
            return L("No location data yet. Connect to a Hub, or enable direct lookups in settings.")
        case .noTrafficInPeriod:
            return L("No connections in this period.")
        }
    }

    private var summary: String {
        guard let busiest = model.points.last else {
            return L("No connections in this period.")
        }
        let place = busiest.city ?? busiest.countryCode ?? L("an unnamed place")
        return L("%1$lld places, %2$lld%% of traffic placed. The busiest is %3$@.",
                 model.points.count, Int((model.placedShare * 100).rounded()), place)
    }

    private func draw(in context: inout GraphicsContext, size: CGSize, spin: Double) {
        let side = min(size.width, size.height)
        let rect = CGRect(
            x: (size.width - side) / 2, y: (size.height - side) / 2, width: side, height: side
        )
        let projection = OrthographicProjection(
            centerLatitude: tilt, centerLongitude: home.longitude + spin
        )

        context.fill(Path(ellipseIn: rect), with: .color(.blue.opacity(0.10)))
        context.stroke(Path(ellipseIn: rect), with: .color(.cyan.opacity(0.35)), lineWidth: 1)

        if let atlas {
            var land = Path()
            for ring in atlas.rings {
                var started = false
                for point in ring {
                    guard let projected = projection.project(
                        latitude: point.latitude, longitude: point.longitude, in: rect
                    ) else {
                        started = false
                        continue
                    }
                    if started { land.addLine(to: projected) } else {
                        land.move(to: projected); started = true
                    }
                }
            }
            context.stroke(land, with: .color(.cyan.opacity(0.55)), lineWidth: 0.6)
        }

        // Traffic leaves from here, so every arc starts at the same place and
        // the picture reads as "this Mac reaching out" rather than scattered
        // dots.
        let homePoint = projection.project(
            latitude: home.latitude, longitude: home.longitude, in: rect
        )

        for point in model.points {
            let arc = GreatCircle.path(
                from: home, to: (latitude: point.latitude, longitude: point.longitude)
            )
            var visible = Path()
            var hidden = Path()
            var visibleStarted = false
            var hiddenStarted = false
            for step in arc {
                if let projected = projection.project(
                    latitude: step.latitude, longitude: step.longitude, in: rect
                ) {
                    hiddenStarted = false
                    if visibleStarted { visible.addLine(to: projected) } else {
                        visible.move(to: projected); visibleStarted = true
                    }
                } else {
                    // Behind the globe. Drawn faintly rather than dropped, so a
                    // destination on the far side is not mistaken for absent.
                    visibleStarted = false
                    let edge = projection.projectClamped(
                        latitude: step.latitude, longitude: step.longitude, in: rect
                    )
                    if hiddenStarted { hidden.addLine(to: edge) } else {
                        hidden.move(to: edge); hiddenStarted = true
                    }
                }
            }
            context.stroke(hidden, with: .color(.orange.opacity(0.10)), lineWidth: 0.7)
            context.stroke(visible, with: .color(.orange.opacity(0.55)), lineWidth: 0.9)
        }

        for point in model.points {
            // Area, not radius, follows the share: doubling a radius would
            // quadruple the ink and overstate the difference.
            let radius = max(2.0, sqrt(point.weight) * side * 0.14)
            let front = projection.project(
                latitude: point.latitude, longitude: point.longitude, in: rect
            )
            let position = front ?? projection.projectClamped(
                latitude: point.latitude, longitude: point.longitude, in: rect
            )
            let mark = CGRect(
                x: position.x - radius, y: position.y - radius,
                width: radius * 2, height: radius * 2
            )
            context.fill(
                Path(ellipseIn: mark),
                with: .color(.orange.opacity(front == nil ? 0.18 : 0.85))
            )
        }

        if let homePoint {
            let marker = CGRect(x: homePoint.x - 4, y: homePoint.y - 4, width: 8, height: 8)
            context.fill(Path(ellipseIn: marker), with: .color(.yellow))
            context.stroke(Path(ellipseIn: marker.insetBy(dx: -3, dy: -3)),
                           with: .color(.yellow.opacity(0.5)), lineWidth: 1)
        }
    }
}

private struct AgentSankeyChart: View {
    let model: SankeyModel

    var body: some View {
        AgentChartCard(
            title: L("Which application went where"),
            subtitle: model.metric == .bytes
                ? L("Ribbon width is data volume")
                : L("Ribbon width is the number of connections")
        ) {
            if model.isEmpty {
                AgentEmptyChartNote(
                    text: model.byteCoverageIsPartial
                        ? L("No data volume has been measured in this period yet.")
                        : L("No connections in this period.")
                )
            } else {
                // Names beside the diagram rather than under it: a flow is read
                // left to right, and a legend below makes the reader carry a
                // colour across the card to find out what an end of a ribbon
                // is.
                HStack(alignment: .top, spacing: 12) {
                    AgentSankeyColumn(
                        title: L("Source"),
                        nodes: model.apps,
                        metric: model.metric,
                        coloured: true,
                        alignment: .leading
                    )
                    GeometryReader { proxy in
                        Canvas { context, size in draw(in: &context, size: size) }
                            .frame(width: proxy.size.width)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .accessibilityElement()
                    .accessibilityLabel(summary)
                    AgentSankeyColumn(
                        title: L("Destination"),
                        nodes: model.destinations,
                        metric: model.metric,
                        coloured: false,
                        alignment: .trailing
                    )
                }
            }
            if model.byteCoverageIsPartial {
                AgentPartialCoverageNote(count: model.observationsWithoutBytes)
            }
        }
    }

    private var summary: String {
        model.accessibilitySummary(
            metricName: { $0 == .bytes ? L("data volume") : L("connections") },
            formattedValue: formattedMetric,
            empty: L("No connections in this period."),
            template: { metric, total, apps, destinations in
                L("%1$@ of %2$@ across %3$lld applications and %4$lld destinations.",
                  total, metric, apps, destinations)
            },
            leaders: { app, destination, share in
                L("%1$@ accounts for %2$lld percent; the busiest destination is %3$@.",
                  app, share, destination)
            }
        )
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let inset = CGSize(width: size.width, height: max(0, size.height - 8))
        let layout = SankeyLayout(nodeWidth: 10, nodeGap: 6).layout(model, in: inset)
        let appIndex = Dictionary(uniqueKeysWithValues: layout.apps.enumerated().map { ($1.name, $0) })

        for ribbon in layout.ribbons {
            let colour = agentSeriesColor(
                appIndex[ribbon.source] ?? 0,
                isRemainder: ribbon.source == SankeyAggregator().remainderName
            )
            var path = Path()
            let leftX = layout.apps.first?.rect.maxX ?? 0
            let rightX = layout.destinations.first?.rect.minX ?? size.width
            let control = (rightX - leftX) * 0.5
            path.move(to: CGPoint(x: leftX, y: ribbon.sourceRange.lowerBound))
            path.addCurve(
                to: CGPoint(x: rightX, y: ribbon.targetRange.lowerBound),
                control1: CGPoint(x: leftX + control, y: ribbon.sourceRange.lowerBound),
                control2: CGPoint(x: rightX - control, y: ribbon.targetRange.lowerBound)
            )
            path.addLine(to: CGPoint(x: rightX, y: ribbon.targetRange.upperBound))
            path.addCurve(
                to: CGPoint(x: leftX, y: ribbon.sourceRange.upperBound),
                control1: CGPoint(x: rightX - control, y: ribbon.targetRange.upperBound),
                control2: CGPoint(x: leftX + control, y: ribbon.sourceRange.upperBound)
            )
            path.closeSubpath()
            context.fill(path, with: .color(colour.opacity(0.35)))
        }

        for (index, node) in layout.apps.enumerated() {
            context.fill(Path(node.rect), with: .color(agentSeriesColor(index, isRemainder: node.isRemainder)))
        }
        for node in layout.destinations {
            context.fill(Path(node.rect), with: .color(Color.secondary.opacity(0.6)))
        }
    }
}

/// One side of the sankey: the names of the ends of the ribbons, next to them.
private struct AgentSankeyColumn: View {
    let title: String
    let nodes: [SankeyNode]
    let metric: TrafficMetric
    let coloured: Bool
    let alignment: HorizontalAlignment

    var body: some View {
        VStack(alignment: alignment, spacing: 3) {
            Text(title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            ForEach(Array(nodes.enumerated()), id: \.element.name) { index, node in
                row(index: index, node: node)
            }
            Spacer(minLength: 0)
        }
        .font(.caption)
        .frame(width: 150, alignment: alignment == .leading ? .leading : .trailing)
    }

    @ViewBuilder
    private func row(index: Int, node: SankeyNode) -> some View {
        let dot = Circle()
            .fill(coloured
                  ? agentSeriesColor(index, isRemainder: node.isRemainder)
                  : Color.secondary.opacity(0.6))
            .frame(width: 7, height: 7)
        let name = Text(node.isRemainder ? L("Other") : node.name)
            .lineLimit(1)
            .truncationMode(.middle)
        let value = Text(formattedMetric(node.value, metric))
            .foregroundStyle(.secondary)
            .lineLimit(1)

        HStack(spacing: 6) {
            // The dot sits against the diagram on both sides, so each name
            // reads outward from the ribbon it belongs to.
            if alignment == .leading {
                dot
                name
                Spacer(minLength: 0)
                value
            } else {
                value
                Spacer(minLength: 0)
                name
                dot
            }
        }
    }
}

private struct AgentSeriesLegend: View {
    struct Entry: Identifiable {
        let name: String
        let color: Color
        var id: String { name }
    }

    let entries: [Entry]

    var body: some View {
        HStack(spacing: 12) {
            ForEach(entries) { entry in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(entry.color).frame(width: 10, height: 10)
                    Text(entry.name == "Other" ? L("Other") : entry.name)
                        .font(.caption)
                        .lineLimit(1)
                }
            }
        }
    }
}

private struct AgentEmptyChartNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
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
        // Bigger than before: the analysis tab now shows five panels at once,
        // and the old default made each of them too short to read.
        window.setContentSize(NSSize(width: 1180, height: 820))
        window.minSize = NSSize(width: 900, height: 620)
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
