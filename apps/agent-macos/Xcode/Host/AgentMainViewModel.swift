import AppKit
import EgressViewAgentCore
import SwiftUI

// The state behind the observation window: what period is selected, what has
// been loaded for it, and what is still being loaded.

struct AgentPeriodSummary: Equatable {
    var sessionCount = 0
    var applicationCount = 0
    var destinationCount = 0
}

struct AgentObservationRow: Identifiable {
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
final class AgentMainViewModel: ObservableObject {
    @Published var selectedTab = AgentMainTab.network {
        didSet {
            guard oldValue != selectedTab else { return }
            // Opening the dedicated threat screen is an explicit request for
            // current results, so it bypasses the long-window screen cache.
            if selectedTab == .threats { threatCandidateCache.invalidate() }
            refresh()
        }
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
    @Published private(set) var localInsights: AgentLocalInsightSnapshot?
    let ollama: AgentOllamaController
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
    ///
    /// Published because the globe reads it to decide whether to keep turning.
    /// As a plain property the change reached the query throttle but never the
    /// view, so the animation carried on behind a closed window.
    @Published var isWindowVisible = true
    private var ticksSinceRefresh = 0

    private let store: ObservationStore?
    private let loadQueue = DispatchQueue(label: "com.egressview.agent.main-window")
    private let refreshTimer = PeriodicWork()
    private let threatCandidateCache = ThreatCandidateRefreshCache()

    init(store: ObservationStore?, ollama: AgentOllamaController) {
        self.store = store
        self.ollama = ollama
    }

    func start() {
        refresh()
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
        // This was a mitigation. The fix -- `chart_hourly`, updated as
        // observations arrive -- shipped in 0.5.0 and took the query from
        // 473ms to 31ms. The interval stays because there is nothing to gain
        // from redrawing faster than the eye reads.
        refreshTimer.start(every: 15) { [weak self] in
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
        refreshTimer.stop()
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
        // Notification history is held by AgentUserNotifier and publishes its
        // own changes. Do not scan SQLite every fifteen seconds for a tab that
        // does not use the selected connection period.
        guard selectedTab != .notifications else { return }
        guard let store else {
            errorMessage = L("Local history is unavailable because App Group access failed.")
            return
        }
        guard !isRefreshing else { return }
        isRefreshing = true
        let selection = VisualizationSelection(scale: scale, metric: metric, end: Date())
        let grouping = destinationGrouping
        let availability = threatAvailability
        let threatCandidateCache = threatCandidateCache
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
                    let pairs = try store.appDestinationTotals(
                        from: from, to: to, grouping: grouping
                    )
                    // `pairs` already combines chart_hourly, the current
                    // partial hour and legacy rollups. Running hourlyRollup()
                    // as well scanned and sorted the same seven-day raw range
                    // only to derive these three numbers.
                    data.summary = AgentPeriodSummary(
                        sessionCount: pairs.reduce(0) { $0 + $1.sessionCount },
                        applicationCount: Set(pairs.map(\.processName)).count,
                        destinationCount: Set(pairs.map(\.destination)).count
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
                    let countryHistory = try store.countryVisitSummaries()
                    data.globe = GlobeAggregator().aggregate(
                        placed: locations.placed,
                        unplacedSessions: locations.unplacedSessions,
                        unplacedBytes: locations.unplacedBytes,
                        metric: selection.metric,
                        hasLocationData: try store.geoLocationCount() > 0,
                        countryHistory: countryHistory
                    )
                    let sleeps = try store.sleepPeriods(from: from, to: to)
                    data.sleepPeriods = sleeps
                    data.coverage = CoverageCalculator.summarize(
                        sessions: try store.coverageSessions(from: from, to: to),
                        sleepPeriods: sleeps,
                        from: from, to: to
                    )
                }

                if tab == .insights {
                    let current = try store.appDestinationTotals(
                        from: from, to: to, grouping: .name
                    )
                    let duration = to.timeIntervalSince(from)
                    let previousStart = from.addingTimeInterval(-duration)
                    let previous = try store.appDestinationTotals(
                        from: previousStart, to: from, grouping: .name
                    )
                    data.localInsights = try AgentLocalInsightBuilder.build(
                        current: current,
                        previous: previous,
                        periodStart: from,
                        periodEnd: to,
                        generatedAt: to
                    )
                }

                // The threat count appears on the network tab too, so it is
                // computed for both -- but only there, and never for the log.
                if tab == .network || tab == .threats {
                    let candidates = try threatCandidateCache.candidates(scale: selection.scale) {
                        try store.destinationsForThreatMatching(from: from, to: to)
                    }
                    data.threats = ThreatReport.evaluate(
                        candidates: candidates,
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
        var localInsights: AgentLocalInsightSnapshot?
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
        if let value = data.localInsights { localInsights = value }
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
