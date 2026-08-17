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
    /// Its own tab rather than a badge somewhere. If a destination on a threat
    /// feed was reached, that is not a detail of another view.
    case threats

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return L("Network status")
        case .threats: return L("Threats")
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
    let countryCode: String?
    /// What the destination column shows. Held rather than recomputed so that
    /// sorting, filtering and display can never disagree about it.
    let destinationText: String

    var observedAt: Date { observation.lastObservedAt }
    var application: String {
        observation.processName.isEmpty ? "PID \(observation.processID)" : observation.processName
    }
    var countryName: String {
        guard let countryCode else { return L("Unknown") }
        return Locale.current.localizedString(forRegionCode: countryCode) ?? countryCode
    }
    var port: Int { Int(observation.remotePort) }
    var protocolName: String { observation.networkProtocol.rawValue.uppercased() }
    var sourceName: String {
        observation.collector == .networkExtension ? L("Network") : L("Lightweight")
    }
    /// Unmeasured sorts as -1 so it groups at one end rather than mixing in
    /// with connections that really did move no data.
    var bytesSort: Int64 {
        guard observation.bytesIn != nil || observation.bytesOut != nil else { return -1 }
        return Int64(clamping: (observation.bytesIn ?? 0) + (observation.bytesOut ?? 0))
    }
    var bytesText: String {
        bytesSort < 0
            ? L("Not measured")
            : ByteCountFormatter.string(fromByteCount: bytesSort, countStyle: .binary)
    }
}

@MainActor
private final class AgentMainViewModel: ObservableObject {
    @Published var selectedTab = AgentMainTab.network {
        didSet { if oldValue != selectedTab { refresh() } }
    }
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
    @Published var logFilter = ConnectionLogFilter()
    @Published var logSort = [KeyPathComparator(\AgentObservationRow.observedAt, order: .reverse)]

    /// The rows after filtering and sorting, which is what the table shows and
    /// what the count beside it must therefore report.
    ///
    /// Cached rather than recomputed. SwiftUI reads this several times per
    /// layout pass, and filtering then sorting 500 rows on each read is work
    /// that only changes when the rows, the filter or the sort do.
    private var cachedVisibleRows: [AgentObservationRow] = []
    private var visibleRowsKey: Int = -1

    var visibleRows: [AgentObservationRow] {
        var hasher = Hasher()
        hasher.combine(observationRows.count)
        hasher.combine(observationRows.first?.id)
        hasher.combine(logFilter)
        hasher.combine(logSort.map { "\($0.order)" }.joined())
        let key = hasher.finalize()
        if key == visibleRowsKey { return cachedVisibleRows }
        let rows = observationRows.filter {
            logFilter.matches(
                $0.observation, destinationText: $0.destinationText, countryCode: $0.countryCode
            )
        }.sorted(using: logSort)
        // Caching inside a getter needs the box to be mutable; the model is
        // MainActor-isolated, so this is not a race.
        let model = self
        model.cachedVisibleRows = rows
        model.visibleRowsKey = key
        return rows
    }

    /// Countries actually present, so the menu never offers a choice that
    /// matches nothing.
    var availableCountries: [(code: String, name: String)] {
        let codes = Set(observationRows.compactMap(\.countryCode))
        return codes.map {
            (code: $0, name: Locale.current.localizedString(forRegionCode: $0) ?? $0)
        }.sorted { $0.name < $1.name }
    }
    @Published private(set) var summary = AgentPeriodSummary()
    @Published private(set) var coverage = CoverageSummary(
        share: 1, firstCovered: nil, gaps: [], startedInsidePeriod: false
    )
    @Published private(set) var sleepPeriods: [DateInterval] = []
    /// True when the period reaches back into hours that were folded into
    /// totals, which changes what the charts can say about them.
    @Published private(set) var usesRolledUpHistory = false
    @Published private(set) var threats = ThreatReport(findings: [], availability: .notFetchedYet)
    /// Set by the app delegate from the controller that fetches indicators.
    var threatAvailability: ThreatIntelAvailability = .notFetchedYet
    @Published private(set) var storage: ObservationStoreStatistics?
    @Published private(set) var monitoringStatus = L("Monitoring paused")
    @Published private(set) var errorMessage: String?
    @Published private(set) var isRefreshing = false
    /// Set after a successful export so the screen can confirm it happened.
    /// A save that produces no visible change is indistinguishable from one
    /// that silently failed.
    @Published var exportedFileURL: URL?
    /// Set by the window controller. A hidden window is not worth querying for.
    var isWindowVisible = true
    private var ticksSinceRefresh = 0

    private let store: ObservationStore?
    private let loadQueue = DispatchQueue(label: "com.egressview.agent.main-window")
    private var refreshTimer: Timer?

    init(store: ObservationStore?) {
        self.store = store
    }

    func start() {
        refresh()
        refreshTimer?.invalidate()
        // Four seconds, and only while the window is on screen. Eight queries
        // over a 39 MB database every two seconds, republishing every value the
        // analysis tab is built from, made the app the busiest process on the
        // Mac -- while showing numbers that change slowly and, half the time,
        // to nobody.
        // Fifteen seconds, not five. Measured on this Mac: each grouped scan
        // over the 358,000-row observations table costs 200-260 ms, and the
        // network tab needs six of them, so a refresh is over a second of
        // SQLite work. At five seconds that is a fifth of a core, permanently,
        // to re-answer questions whose answers barely moved.
        //
        // This is a mitigation, not the fix. The fix is to serve long periods
        // from `hourly_rollup`, which exists for exactly this and is not being
        // used by the charts.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.isWindowVisible else { return }
                // Four times slower again when the app is not the one being
                // used: nobody is reading numbers they cannot see.
                if !NSApp.isActive {
                    self.ticksSinceRefresh += 1
                    guard self.ticksSinceRefresh >= 4 else { return }
                }
                self.ticksSinceRefresh = 0
                self.refresh()
            }
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

        // This app is an accessory (LSUIElement), so it is not the active
        // application and `runModal()` had nothing to put the panel in front
        // of: pressing the button did nothing at all, with no error anywhere.
        // As a sheet on the window the button was pressed in, there is always
        // something to attach to.
        guard let window = NSApp.keyWindow ?? NSApp.windows.first(where: \.isVisible) else {
            errorMessage = L("Could not open the save panel because no window is open.")
            return
        }
        NSApp.activate(ignoringOtherApps: true)
        panel.beginSheetModal(for: window) { [weak self] response in
            guard let self, response == .OK, let url = panel.url else { return }
            self.writeCSV(to: url, store: store, selection: selection)
        }
    }

    private func writeCSV(
        to url: URL, store: ObservationStore, selection: VisualizationSelection
    ) {
        do {
            let observations = try store.observations(
                since: selection.start, limit: Int.max
            ).filter { $0.lastObservedAt <= selection.end }
            try ObservationCSV.export(observations)
                .write(to: url, atomically: true, encoding: .utf8)
            errorMessage = nil
            exportedFileURL = url
        } catch {
            // Writing needs the user-selected-file entitlement; without it the
            // panel appears and the save fails. Saying nothing here would
            // repeat the original bug one step further along.
            errorMessage = L("Could not write the file: %@", error.localizedDescription)
        }
    }

    /// The destination as the user asked to see it.
    ///
    /// This ignored the "Destinations by" setting entirely and always printed
    /// the address, so choosing Name changed every chart and left the log
    /// looking as though the setting had not worked. Where no name was ever
    /// recorded the address is still shown: an empty cell would read as missing
    /// data rather than as a destination that was only ever an address.
    static func destinationText(
        _ observation: ConnectionObservation, grouping: DestinationGrouping
    ) -> String {
        if grouping == .name, let hostname = observation.remoteHostname, !hostname.isEmpty {
            return hostname
        }
        return observation.remoteAddress.contains(":")
            ? "[\(observation.remoteAddress)]"
            : observation.remoteAddress
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
        let availability = threatAvailability
        // Only what the visible tab shows. Every query here scans a range of a
        // 55 MB table and sorts it -- profiling put the app's CPU in SQLite,
        // not in drawing -- and running the log's and the threat tab's queries
        // while looking at the charts is work for a screen nobody is on.
        let tab = selectedTab
        loadQueue.async { [weak self] in
            let from = selection.start
            let to = selection.end
            let result = Result { () -> LoadedData in
                var data = LoadedData()
                data.storage = try store.statistics()

                data.usesRolledUpHistory = try store.periodUsesRolledUpHistory(from: from, to: to)
                if tab == .network {
                    let rollup = try store.hourlyRollup(from: from, to: to)
                    data.summary = AgentPeriodSummary(
                        sessionCount: rollup.reduce(0) { $0 + $1.sessionCount },
                        applicationCount: Set(rollup.map(\.processName)).count,
                        destinationCount: Set(rollup.map(\.remoteAddress)).count
                    )
                    let pairs = try store.appDestinationTotals(
                        from: from, to: to, grouping: grouping
                    )
                    let buckets = try store.appTimeline(
                        from: from, to: to, buckets: VisualizationSelection.bucketCount
                    )
                    // The byte view is offered only once something has actually
                    // been measured; otherwise every bar would be empty.
                    data.measuredBytes = pairs.contains { $0.bytes > 0 }
                    data.sankey = SankeyAggregator().aggregate(pairs, metric: selection.metric)
                    data.timeline = TimelineAggregator().aggregate(buckets, selection: selection)
                    let locations = try store.destinationLocations(from: from, to: to)
                    data.globe = GlobeAggregator().aggregate(
                        placed: locations.placed,
                        unplacedSessions: locations.unplacedSessions,
                        unplacedBytes: locations.unplacedBytes,
                        metric: selection.metric,
                        hasLocationData: try store.geoLocationCount() > 0
                    )
                    let sleeps = try store.sleepPeriods(from: from, to: to)
                    data.sleepPeriods = sleeps
                    data.coverage = CoverageCalculator.summarize(
                        sessions: try store.coverageSessions(from: from, to: to),
                        sleepPeriods: sleeps,
                        from: from, to: to
                    )
                }

                // The threat count appears on the network tab too, so it is
                // computed for both -- but only there, and never for the log.
                if tab == .network || tab == .threats {
                    data.threats = ThreatReport.evaluate(
                        candidates: try store.destinationsForThreatMatching(from: from, to: to),
                        matcher: ThreatMatcher(indicators: try store.threatIndicators()),
                        availability: availability
                    )
                }

                if tab == .log {
                    let observations = try store.observations(since: from, limit: 500)
                    let countries = try store.countryCodes(
                        forAddresses: observations.map(\.remoteAddress)
                    )
                    data.rows = observations.enumerated().map { index, observation in
                        AgentObservationRow(
                            id: "\(observation.stableKey)|\(observation.lastObservedAt.timeIntervalSince1970)|\(index)",
                            observation: observation,
                            countryCode: countries[observation.remoteAddress],
                            destinationText: Self.destinationText(observation, grouping: grouping)
                        )
                    }
                }
                return data
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isRefreshing = false
                switch result {
                case .success(let data):
                    self.apply(data, tab: tab)
                    self.errorMessage = nil
                case .failure(let error):
                    self.errorMessage = error.localizedDescription
                }
            }
        }
    }

    /// Everything a refresh can produce. Only the fields the visible tab needs
    /// are filled in; the rest keep whatever they already held.
    private struct LoadedData {
        var summary: AgentPeriodSummary?
        var sankey: SankeyModel?
        var timeline: TimelineModel?
        var globe: GlobeModel?
        var coverage: CoverageSummary?
        var sleepPeriods: [DateInterval]?
        var threats: ThreatReport?
        var rows: [AgentObservationRow]?
        var storage: ObservationStoreStatistics?
        var measuredBytes: Bool?
        var usesRolledUpHistory: Bool?
    }

    private func apply(_ data: LoadedData, tab: AgentMainTab) {
        if let value = data.summary { summary = value }
        if let value = data.sankey { sankey = value }
        if let value = data.timeline { timeline = value }
        if let value = data.globe { globe = value }
        if let value = data.coverage { coverage = value }
        if let value = data.sleepPeriods { sleepPeriods = value }
        if let value = data.threats { threats = value }
        if let value = data.rows { observationRows = value }
        if let value = data.storage { storage = value }
        if let value = data.usesRolledUpHistory { usesRolledUpHistory = value }
        if let measured = data.measuredBytes {
            availableMetrics = VisualizationSelection.availableMetrics(hasMeasuredBytes: measured)
            if !availableMetrics.contains(metric) { metric = .sessions }
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
                case .threats: threatsView
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
                            storage: model.storage,
                            threats: model.threats
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
                        AgentTimelineChart(
                            model: model.timeline, scale: model.scale,
                            sleepPeriods: model.sleepPeriods
                        )
                            .frame(maxWidth: .infinity)
                    }
                    .frame(height: metrics.middleHeight)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
            }
        }
    }

    private var threatsView: some View {
        VStack(spacing: 0) {
            analysisControls
            errorBanner
            AgentThreatPanel(report: model.threats, scale: model.scale)
                .padding(.horizontal, 20)
                .padding(.bottom, 18)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
                .disabled(model.selectedTab != .network)
                .help(model.selectedTab == .network
                      ? L("Whether the charts are sized by connection count or by data volume")
                      : L("The measure sizes the marks on the charts. This tab lists every row either way."))
            destinationGroupingPicker
                // The threats table always shows the name when one was
                // recorded, and the detail shows the address alongside it, so
                // there is nothing for this to change. Disabled rather than
                // hidden, so the controls do not move between tabs.
                .disabled(model.selectedTab == .threats)
                .help(model.selectedTab == .threats
                      ? L("Threats show the name and the address together, so there is nothing to choose between.")
                      : L("A name groups a service together; an address shows how far its traffic is spread."))
            Spacer()
            Button {
                model.exportCSV()
            } label: {
                Label(L("Export CSV..."), systemImage: "square.and.arrow.up")
            }
            .help(L("Saves every connection in the selected period as a CSV file"))
            if let url = model.exportedFileURL {
                Button {
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                } label: {
                    Label(L("Saved: %@", url.lastPathComponent), systemImage: "checkmark.circle")
                }
                .buttonStyle(.link)
                .help(L("Show the file in the Finder"))
            }
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
                // The count reports what is on screen. Reporting the unfiltered
                // total beside a filtered table would make the filter look
                // broken.
                Text(model.logFilter.isActive
                     ? L("%1$lld of %2$lld shown", model.visibleRows.count, model.observationRows.count)
                     : L("%lld shown", model.observationRows.count))
                    .foregroundStyle(.secondary)
                if model.logFilter.isActive {
                    Button(L("Clear filters")) { model.logFilter = ConnectionLogFilter() }
                }
            }
            AgentLogFilterBar(model: model)
            Table(model.visibleRows, sortOrder: $model.logSort) {
                TableColumn(L("Observed"), value: \.observedAt) { row in
                    Text(Self.observedFormatter.string(from: row.observedAt))
                        .monospacedDigit()
                }
                .width(min: 150, ideal: 170)
                TableColumn(L("Application"), value: \.application) { row in
                    Text(row.application)
                }
                .width(min: 130, ideal: 180)
                TableColumn(L("Destination"), value: \.destinationText) { row in
                    Text(row.destinationText)
                        .monospaced()
                        .help(row.destinationText)
                }
                .width(min: 180, ideal: 280)
                TableColumn(L("Country"), value: \.countryName) { row in
                    Text(row.countryName)
                        .foregroundStyle(row.countryCode == nil ? .secondary : .primary)
                }
                .width(min: 90, ideal: 120)
                TableColumn(L("Data volume"), value: \.bytesSort) { row in
                    Text(row.bytesText)
                        .monospacedDigit()
                        .foregroundStyle(row.bytesSort < 0 ? .secondary : .primary)
                }
                .width(min: 90, ideal: 110)
                TableColumn(L("Protocol"), value: \.protocolName) { row in
                    Text(row.protocolName)
                }
                .width(70)
                TableColumn(L("Port"), value: \.port) { row in
                    Text(String(row.port))
                        .monospacedDigit()
                }
                .width(60)
                TableColumn(L("Source"), value: \.sourceName) { row in
                    Text(row.sourceName)
                }
                .width(100)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(16)
        .agentSection()
    }

    /// Date and time to the second. A bare time made two rows a day apart look
    /// like two rows a minute apart.
    private static let observedFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter
    }()

}

/// A filter per column, because the questions asked of this table are
/// per-column ones. A single search box cannot express "UDP to port 443".
///
/// The observed time has no filter: the period picker above already governs it,
/// and a second control for the same thing invites the two to disagree.
private struct AgentLogFilterBar: View {
    @ObservedObject var model: AgentMainViewModel

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { controls }
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) { textFilters }
                HStack(spacing: 8) { menuFilters }
            }
        }
        .controlSize(.small)
        .font(.caption)
    }

    @ViewBuilder
    private var controls: some View {
        textFilters
        menuFilters
    }

    @ViewBuilder
    private var textFilters: some View {
        field(L("Application"), text: $model.logFilter.application, width: 140)
        field(L("Destination"), text: $model.logFilter.destination, width: 170)
        field(L("Port"), text: $model.logFilter.port, width: 70)
    }

    @ViewBuilder
    private var menuFilters: some View {
        Picker(L("Country"), selection: countryBinding) {
            Text(L("Country: any")).tag(CountryChoice.any)
            Text(L("Unknown")).tag(CountryChoice.unplaced)
            Divider()
            ForEach(model.availableCountries, id: \.code) { entry in
                Text(entry.name).tag(CountryChoice.code(entry.code))
            }
        }
        .labelsHidden()
        .frame(width: 130)

        Picker(L("Protocol"), selection: $model.logFilter.networkProtocol) {
            Text(L("Protocol: any")).tag(InternetProtocol?.none)
            ForEach(InternetProtocol.allCases, id: \.self) { value in
                Text(value.rawValue.uppercased()).tag(InternetProtocol?.some(value))
            }
        }
        .labelsHidden()
        .frame(width: 110)

        Picker(L("Data volume"), selection: $model.logFilter.volume) {
            Text(L("Volume: any")).tag(ConnectionLogFilter.Volume.any)
            Text(L("Measured")).tag(ConnectionLogFilter.Volume.measured)
            Text(L("Not measured")).tag(ConnectionLogFilter.Volume.unmeasured)
        }
        .labelsHidden()
        .frame(width: 130)

        Picker(L("Source"), selection: $model.logFilter.collector) {
            Text(L("Source: any")).tag(CollectorKind?.none)
            Text(L("Network")).tag(CollectorKind?.some(.networkExtension))
            Text(L("Lightweight")).tag(CollectorKind?.some(.libproc))
        }
        .labelsHidden()
        .frame(width: 120)
    }

    private func field(_ placeholder: String, text: Binding<String>, width: CGFloat) -> some View {
        TextField(placeholder, text: text)
            .textFieldStyle(.roundedBorder)
            .frame(width: width)
    }

    /// "Unknown" is a real answer people look for, so it is a choice rather
    /// than the absence of one.
    private enum CountryChoice: Hashable {
        case any
        case unplaced
        case code(String)
    }

    private var countryBinding: Binding<CountryChoice> {
        Binding(
            get: {
                if model.logFilter.isUnplacedCountryOnly { return .unplaced }
                if let code = model.logFilter.country { return .code(code) }
                return .any
            },
            set: { choice in
                switch choice {
                case .any:
                    model.logFilter.country = nil
                    model.logFilter.isUnplacedCountryOnly = false
                case .unplaced:
                    model.logFilter.country = nil
                    model.logFilter.isUnplacedCountryOnly = true
                case .code(let code):
                    model.logFilter.country = code
                    model.logFilter.isUnplacedCountryOnly = false
                }
            }
        )
    }
}

/// The threats tab.
///
/// Its most important job is the one that shows nothing: saying "nobody
/// looked" rather than "nothing found". An empty list from a screen that never
/// had indicators would present an unexamined period as a clean one, which is
/// the same failure as an empty chart reading as a quiet network.
private struct AgentThreatPanel: View {
    let report: ThreatReport
    let scale: TimeScale
    @State private var selection: ThreatFinding.ID?

    static func reason(_ availability: ThreatIntelAvailability) -> String {
        switch availability {
        case .checked:
            return ""
        case .notEnabled:
            return L("Threat information is not switched on, so nothing was checked. Connect a Hub, or turn on feed downloads in settings.")
        case .hubHasNoFeeds:
            return L("The Hub is not running threat feeds, so nothing was checked.")
        case .notFetchedYet:
            return L("Threat information has not arrived yet, so nothing was checked.")
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if !report.wasChecked {
                AgentEmptyChartNote(text: Self.reason(report.availability))
                Spacer(minLength: 0)
            } else if report.findings.isEmpty {
                AgentEmptyChartNote(
                    text: L("Nothing in this period matched a threat feed. That covers the feeds this agent holds, and nothing beyond them.")
                )
                Spacer(minLength: 0)
            } else {
                table
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .agentSection()
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("Destinations on a threat feed"))
                    .font(.title2.weight(.semibold))
                Text(subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if report.wasChecked, report.destinationCount > 0 {
                Label(
                    L("%lld destinations", report.destinationCount),
                    systemImage: "exclamationmark.triangle.fill"
                )
                .font(.callout.weight(.medium))
                .foregroundStyle(.orange)
            }
        }
    }

    private var subtitle: String {
        guard case let .checked(count, fetchedAt) = report.availability else {
            return L("Nothing was checked in %@", scale.title)
        }
        guard let fetchedAt else {
            return L("%1$lld indicators, %2$@", count, scale.title)
        }
        return L("%1$lld indicators updated %2$@, %3$@",
                 count,
                 RelativeDateTimeFormatter().localizedString(for: fetchedAt, relativeTo: Date()),
                 scale.title)
    }

    private var table: some View {
        // Split so the detail has somewhere to go. A row in a table can only
        // say so much before the columns stop being readable, and the things
        // worth knowing about a threat -- the whole matched value, when it
        // started, how much moved -- are exactly the things that do not fit.
        VSplitView {
            Table(report.findings, selection: $selection) {
                TableColumn(L("Destination")) { finding in
                    Text(finding.candidate.hostname ?? finding.candidate.address)
                        .monospaced()
                        .help(Self.tooltip(for: finding))
                }
                .width(min: 170, ideal: 240)
                TableColumn(L("Application")) { finding in
                    Text(finding.candidate.processName)
                        .help(Self.tooltip(for: finding))
                }
                .width(min: 110, ideal: 150)
                TableColumn(L("Matched")) { finding in
                    Text(finding.match.matchedValue)
                        .monospaced()
                        .help(Self.tooltip(for: finding))
                }
                .width(min: 130, ideal: 180)
                TableColumn(L("Why")) { finding in
                    Text(finding.match.indicator.tag ?? L("Listed"))
                        .help(Self.tooltip(for: finding))
                }
                .width(min: 130, ideal: 190)
                TableColumn(L("Feed")) { finding in
                    Text(finding.match.indicator.source ?? L("Unknown"))
                }
                .width(90)
                TableColumn(L("Connections")) { finding in
                    Text(finding.candidate.sessionCount.formatted())
                        .monospacedDigit()
                }
                .width(80)
                TableColumn(L("Data volume")) { finding in
                    // A floor, not a total, when some connections are still
                    // open: byte counts arrive when a connection closes, and a
                    // figure presented as complete would understate quietly.
                    Text(Self.volume(finding.candidate))
                        .monospacedDigit()
                        .foregroundStyle(finding.candidate.bytes == 0 ? .secondary : .primary)
                        .help(finding.candidate.bytesArePartial
                              ? L("At least this much. %lld of these connections have not reported a byte count yet.",
                                  finding.candidate.observationsWithoutBytes)
                              : L("Measured over connections that have closed."))
                }
                .width(min: 90, ideal: 110)
                TableColumn(L("Last seen")) { finding in
                    Text(finding.candidate.lastObservedAt, style: .time)
                        .monospacedDigit()
                }
                .width(80)
            }
            .frame(minHeight: 160)

            detail
                .frame(minHeight: 120)
        }
    }

    /// The detail pane.
    ///
    /// Both states -- a selected row and the prompt to select one -- are put
    /// inside the same always-filling frame. Letting each size itself made the
    /// pane jump smaller the moment a row was clicked, which moves the table
    /// under the pointer that just clicked it.
    private var detail: some View {
        ScrollView {
            Group {
                if let finding = report.findings.first(where: { $0.id == selection }) {
                    detailBody(finding)
                } else {
                    Text(L("Select a row to see the whole match."))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func detailBody(_ finding: ThreatFinding) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(finding.candidate.hostname ?? finding.candidate.address)
                .font(.title3.weight(.semibold))
                .monospaced()
                .textSelection(.enabled)

            LazyVGrid(
                columns: [GridItem(.fixed(150), alignment: .trailing),
                          GridItem(.flexible(), alignment: .leading)],
                alignment: .leading, spacing: 7
            ) {
                field(L("Address"), finding.candidate.address)
                if let hostname = finding.candidate.hostname {
                    field(L("Name the app asked for"), hostname)
                }
                field(L("Application"), finding.candidate.processName)
                // What was on the list, which is not always the destination: a
                // parent domain can be the listed thing.
                field(L("What was on the list"), finding.match.matchedValue)
                field(L("Kind of indicator"), Self.kindName(finding.match.indicator.kind))
                field(L("Feed"), finding.match.indicator.source ?? L("Unknown"))
                field(L("Why"), finding.match.indicator.tag ?? L("Listed"))
                field(L("Connections"), finding.candidate.sessionCount.formatted())
                field(L("Data volume"), Self.volume(finding.candidate))
                field(L("First seen"), Self.stamp(finding.candidate.firstObservedAt))
                field(L("Last seen"), Self.stamp(finding.candidate.lastObservedAt))
            }
            .font(.callout)

            Text(L("A feed listing is not proof of harm. It means someone published this destination as associated with the reason above, at some point. What this Mac knows is that %1$@ reached it %2$lld times.",
                   finding.candidate.processName, finding.candidate.sessionCount))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func field(_ label: String, _ value: String) -> some View {
        Group {
            Text(label).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
        }
    }

    /// Everything the row cannot fit, for people who hover rather than click.
    static func tooltip(for finding: ThreatFinding) -> String {
        var lines = [finding.candidate.address]
        if let hostname = finding.candidate.hostname { lines.append(hostname) }
        lines.append(L("On the list: %@", finding.match.matchedValue))
        lines.append(finding.match.indicator.tag ?? L("Listed"))
        lines.append(L("%1$@ · %2$lld connections · %3$@",
                       finding.candidate.processName,
                       finding.candidate.sessionCount,
                       volume(finding.candidate)))
        return lines.joined(separator: "\n")
    }

    static func volume(_ candidate: ThreatCandidate) -> String {
        guard candidate.bytes > 0 else {
            return candidate.bytesArePartial ? L("Not measured") : "0 B"
        }
        let measured = ByteCountFormatter.string(
            fromByteCount: Int64(clamping: candidate.bytes), countStyle: .binary
        )
        return candidate.bytesArePartial ? L("%@ or more", measured) : measured
    }

    static func kindName(_ kind: ThreatIndicator.Kind) -> String {
        switch kind {
        case .ip: return L("Address")
        case .domain: return L("Domain")
        case .cidr: return L("Address range")
        }
    }

    static func stamp(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .short
        formatter.timeStyle = .medium
        return formatter.string(from: date)
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

/// Says that part of the period survives only as hourly totals.
///
/// Not a warning -- the data is there and the numbers are right. It exists
/// because three things silently change about the older half: destinations can
/// only be shown as addresses, nothing finer than an hour is distinguishable,
/// and the count of connections whose data volume was never measured is gone.
/// A reader comparing last week with last month would otherwise conclude the
/// names had stopped being recorded.
private struct AgentRolledUpHistoryNote: View {
    let applies: Bool

    var body: some View {
        if applies {
            Label(
                L("Part of this period is kept as hourly totals. For that part, destinations are shown as addresses, and nothing shorter than an hour is separated out."),
                systemImage: "clock.arrow.circlepath"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.secondary.opacity(0.08))
            )
        }
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
        if coverage.asleep > 60 {
            parts.append(L("%@ of it the Mac was asleep, which is not a fault and not a gap in monitoring.",
                           Self.duration(coverage.asleep)))
        }
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
    let threats: ThreatReport

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
                // A dash, not a zero, when nothing checked. Zero is an answer
                // and this would not be one.
                tile(
                    L("Threats"),
                    threats.wasChecked ? threats.destinationCount.formatted() : "—",
                    threats.wasChecked && threats.destinationCount > 0
                        ? "exclamationmark.triangle.fill" : "shield"
                )
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
                if !threats.wasChecked {
                    Label(AgentThreatPanel.reason(threats.availability), systemImage: "info.circle")
                }
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
    /// Shaded behind the bars. Without this a night of sleep is an empty
    /// stretch of chart, and an empty chart reads as "nothing happened" rather
    /// than "the Mac was not running".
    var sleepPeriods: [DateInterval] = []

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
                if !sleepPeriods.isEmpty {
                    // Says what the shaded band is. An unexplained grey stripe
                    // is worse than no stripe.
                    HStack(spacing: 6) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.secondary.opacity(0.14))
                            .frame(width: 18, height: 10)
                        Text(L("Shaded: the Mac was asleep. Traffic during sleep is not recorded."))
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
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

    private func drawSleep(in context: inout GraphicsContext, plot: CGRect) {
        guard !sleepPeriods.isEmpty, let first = model.bucketStarts.first,
              model.bucketDuration > 0, model.bucketStarts.count > 1 else { return }
        let span = model.bucketDuration * Double(model.bucketStarts.count)
        guard span > 0 else { return }
        for period in sleepPeriods {
            let startX = plot.minX + plot.width * CGFloat(
                max(0, min(1, period.start.timeIntervalSince(first) / span))
            )
            let endX = plot.minX + plot.width * CGFloat(
                max(0, min(1, period.end.timeIntervalSince(first) / span))
            )
            // A sleep too short to draw is still drawn, as a hairline. A period
            // that vanished would be indistinguishable from one that never
            // happened.
            let rect = CGRect(
                x: startX, y: plot.minY, width: max(1, endX - startX), height: plot.height
            )
            context.fill(Path(rect), with: .color(.secondary.opacity(0.14)))
        }
    }

    private func draw(in context: inout GraphicsContext, size: CGSize) {
        let peak = model.bucketTotals.max() ?? 0
        guard peak > 0, model.bucketStarts.count > 1 else { return }
        let plot = CGRect(
            x: yAxisWidth, y: 0,
            width: max(1, size.width - yAxisWidth),
            height: max(1, size.height - xAxisHeight)
        )
        // Behind everything else: the sleep is the background the bars sit on,
        // not a thing drawn over them.
        drawSleep(in: &context, plot: plot)
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
    /// Latitude at the centre of the view, tipped towards the hemisphere the
    /// traffic leaves from. The tilt was previously 12 degrees the wrong way,
    /// which pushed home -- the point every arc starts at -- towards the rim.
    /// Dragging up or down still changes it.
    @State private var tilt: Double = HomeLocation.preferredTilt(
        latitude: HomeLocation.current().latitude
    )
    @State private var isDragging = false
    @State private var resumeAt = Date.distantPast

    /// Whether the globe should be turning at all.
    ///
    /// A globe nobody can see does not need to turn. Spinning behind another
    /// window or in a hidden tab cost the same CPU as spinning in front of the
    /// user, which is a bad trade at any frame rate.
    @Environment(\.controlActiveState) private var controlActiveState

    private var isTurning: Bool { isRunning && !isDragging }
    private var isAnimating: Bool { isTurning && controlActiveState != .inactive }

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
                // 15 frames a second, not 30. At six degrees a second the
                // extra frames are indistinguishable, and each one re-lays out
                // this whole subtree -- SwiftUI layout, not drawing, was where
                // the CPU was going.
                TimelineView(.animation(minimumInterval: 1.0 / 15.0, paused: !isAnimating)) { context in
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
                    //
                    // `fixedSize` stops the picker and button from being
                    // re-measured against a box that changes every frame. They
                    // were the most expensive part of the animation loop, and
                    // their size never actually changes.
                    spinControls
                        .fixedSize()
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
        // Subtracted, not added. The centre of the view moving west is what
        // makes the surface travel east across the screen, which is the way the
        // Earth actually turns: counter-clockwise seen from above the north
        // pole. Adding it ran the planet backwards.
        let projection = OrthographicProjection(
            centerLatitude: tilt, centerLongitude: home.longitude - spin
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
    /// Miniaturised counts as not visible. The window is still "loaded", but
    /// querying and redrawing for a dock icon is work spent on nobody.
    /// Whether anyone was in a position to look for threats. Held on the model
    /// so a period nobody checked is never presented as a clean one.
    func setThreatAvailability(_ availability: ThreatIntelAvailability) {
        model.threatAvailability = availability
        model.refresh()
    }

    func windowDidMiniaturize(_ notification: Notification) {
        model.isWindowVisible = false
    }

    func windowDidDeminiaturize(_ notification: Notification) {
        model.isWindowVisible = true
        model.refresh()
    }

    func windowWillClose(_ notification: Notification) {
        model.isWindowVisible = false
        model.stop()
    }
}
