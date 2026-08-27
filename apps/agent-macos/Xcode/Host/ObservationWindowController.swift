import AppKit
import EgressViewAgentCore
import SwiftUI

enum AgentGlobeFrameRate: Int, CaseIterable, Identifiable {
    case energySaver = 3
    case standard = 5
    case smooth = 15

    static let defaultsKey = "agentGlobeFrameRate"
    static let defaultValue = AgentGlobeFrameRate.standard

    var id: Int { rawValue }

    var title: String {
        switch self {
        case .energySaver: return L("Energy saver (3 fps)")
        case .standard: return L("Standard (5 fps)")
        case .smooth: return L("Smooth (15 fps)")
        }
    }

}

enum AgentMainTab: String, CaseIterable, Identifiable {
    /// What is happening on the network, and whether the agent is in a state to
    /// know. These were two tabs, and separating them meant the charts could be
    /// read without ever seeing that collection had stopped -- which is exactly
    /// how an outage went unnoticed for hours.
    case network
    /// A deterministic local summary first. Phase 1 has no provider client;
    /// the bounded preview below it is the exact shape a later manual AI
    /// action may send after consent.
    case insights
    /// Its own tab. The log wants the whole window -- rows are long and there
    /// are hundreds of them -- and sharing the screen with the charts left both
    /// too short to read.
    case log
    /// Its own tab rather than a badge somewhere. If a destination on a threat
    /// feed was reached, that is not a detail of another view.
    case threats
    /// A local audit of what the agent tried to bring to the user's attention.
    /// Settings control delivery; this tab answers "what changed?".
    case notifications

    var id: String { rawValue }

    var title: String {
        switch self {
        case .network: return L("Network status")
        case .insights: return L("Insights")
        case .threats: return L("Threats")
        case .log: return L("Connection log")
        case .notifications: return L("Notification history")
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

struct AgentMainView: View {
    @ObservedObject var model: AgentMainViewModel
    @ObservedObject private var language = AgentLanguageSettings.shared
    @ObservedObject private var notifications = AgentUserNotifier.shared

    var body: some View {
        VStack(spacing: 0) {
            header
                .id(language.language.rawValue)
            Divider()
            Group {
                switch model.selectedTab {
                case .network: analysisView
                case .insights: insightsView
                case .threats: threatsView
                case .log: logView
                case .notifications: notificationHistoryView
                }
            }
            .id(language.language.rawValue)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .frame(minWidth: 900, minHeight: 620)
        .background(Color(nsColor: .windowBackgroundColor))
        .environment(\.locale, language.language.locale)
    }

    private var header: some View {
        VStack(spacing: 12) {
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
                Group {
                    if model.selectedTab == .notifications {
                        Text(L("All local notification history"))
                            .foregroundStyle(.secondary)
                            .frame(width: 190, alignment: .trailing)
                    } else {
                        Picker(L("Period"), selection: $model.scale) {
                            ForEach(TimeScale.allCases) { scale in
                                Text(scale.title).tag(scale)
                            }
                        }
                        .frame(width: 150)
                    }
                }
                Button {
                    if model.selectedTab == .notifications {
                        notifications.refreshAuthorizationStatus()
                    } else {
                        model.refresh()
                    }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .help(L("Refresh"))
                .disabled(model.isRefreshing)
            }

            Picker(L("View"), selection: $model.selectedTab) {
                ForEach(AgentMainTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 760)
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 14)
    }

    private var analysisView: some View {
        VStack(spacing: 0) {
            analysisControls
            errorBanner
            GeometryReader { proxy in
                let metrics = AnalysisLayout(size: proxy.size)
                VStack(spacing: 14) {
                    HStack(alignment: .top, spacing: 14) {
                        AgentGlobeChart(
                            model: model.globe,
                            atlas: model.atlas,
                            isOnScreen: model.isWindowVisible && model.selectedTab == .network
                        )
                            .frame(width: metrics.globeWidth, height: metrics.topHeight)
                        AgentOverviewPanel(
                            summary: model.summary,
                            coverage: model.coverage,
                            monitoringStatus: model.monitoringStatus,
                            storage: model.storage,
                            threats: model.threats,
                            usesRolledUpHistory: model.usesRolledUpHistory
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

    private var insightsView: some View {
        VStack(spacing: 0) {
            errorBanner
            AgentInsightPanel(
                snapshot: model.localInsights,
                monitoringStatus: model.monitoringStatus,
                isRefreshing: model.isRefreshing
            )
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

    private var notificationHistoryView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 14) {
                    notificationSummaryCard(
                        L("Notifications today"),
                        value: "\(notifications.sentToday)",
                        detail: L("After category and cooldown checks"),
                        tint: .blue
                    )
                    notificationSummaryCard(
                        L("Suppressed today"),
                        value: "\(notifications.suppressedToday)",
                        detail: L("Daily limit only; duplicates are not counted"),
                        tint: notifications.suppressedToday > 0 ? .orange : .teal
                    )
                    notificationSummaryCard(
                        L("macOS permission"),
                        value: notificationPermissionTitle,
                        detail: notificationPermissionDetail,
                        tint: notificationPermissionColor
                    )
                }

                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(L("Notification history")).font(.title2.bold())
                        Text(L("Notification choices and the daily limit can be changed in Settings > Notifications."))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text(L("Newest first · up to 100 local entries"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if notifications.history.isEmpty {
                    VStack(spacing: 12) {
                        Image(systemName: "bell.slash")
                            .font(.system(size: 36))
                            .foregroundStyle(.secondary)
                        Text(L("No notifications have been attempted yet."))
                            .font(.headline)
                        Text(L("Events disabled in Settings and events suppressed by cooldown are not added here."))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, minHeight: 260)
                    .background(Color.teal.opacity(0.06), in: RoundedRectangle(cornerRadius: 14))
                    .overlay {
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(Color.teal.opacity(0.16), lineWidth: 1)
                    }
                } else {
                    LazyVStack(spacing: 10) {
                        ForEach(notifications.history) { entry in
                            notificationHistoryRow(entry)
                        }
                    }
                }
            }
            .padding(20)
        }
    }

    private func notificationSummaryCard(
        _ title: String, value: String, detail: String, tint: Color
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(tint)
            Text(value).font(.title2.bold()).foregroundStyle(.primary)
            Text(detail).font(.caption2).foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
        .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(tint.opacity(0.20), lineWidth: 1)
        }
    }

    private func notificationHistoryRow(_ entry: AgentNotificationHistoryEntry) -> some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: notificationSymbol(entry.kind))
                .font(.title3)
                .foregroundStyle(notificationColor(entry.kind))
                .frame(width: 28, height: 28)
                .background(notificationColor(entry.kind).opacity(0.12), in: Circle())
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(notificationKindTitle(entry.kind))
                        .font(.caption.bold())
                        .foregroundStyle(notificationColor(entry.kind))
                    Text(entry.title).font(.headline)
                    Spacer()
                    Text(DateFormatter.localizedString(
                        from: entry.date, dateStyle: .short, timeStyle: .medium
                    ))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                Text(entry.body).font(.callout).textSelection(.enabled)
                Label(
                    entry.delivered ? L("Sent to macOS") : L("Not sent to macOS"),
                    systemImage: entry.delivered ? "checkmark.circle" : "exclamationmark.circle"
                )
                .font(.caption)
                .foregroundStyle(entry.delivered ? Color.secondary : Color.orange)
            }
        }
        .padding(15)
        .background(notificationColor(entry.kind).opacity(0.065), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(notificationColor(entry.kind).opacity(0.16), lineWidth: 1)
        }
    }

    private var notificationPermissionTitle: String {
        switch notifications.permissionState {
        case .unknown: return L("Not requested")
        case .allowed: return L("Allowed")
        case .denied: return L("Disabled")
        }
    }

    private var notificationPermissionDetail: String {
        switch notifications.permissionState {
        case .unknown: return L("Requested only when needed")
        case .allowed: return L("Focus may still delay display")
        case .denied: return L("Enable it in System Settings")
        }
    }

    private var notificationPermissionColor: Color {
        switch notifications.permissionState {
        case .unknown: return .blue
        case .allowed: return .green
        case .denied: return .orange
        }
    }

    private func notificationKindTitle(_ kind: AgentNotificationKind) -> String {
        switch kind {
        case .threat: return L("Threat")
        case .monitoring: return L("Monitoring")
        case .hubDelivery: return L("Hub delivery")
        case .threatIntelChange: return L("Threat information")
        case .recovery: return L("Recovery")
        }
    }

    private func notificationSymbol(_ kind: AgentNotificationKind) -> String {
        switch kind {
        case .threat: return "exclamationmark.shield"
        case .monitoring: return "waveform.path.ecg"
        case .hubDelivery: return "arrow.up.circle"
        case .threatIntelChange: return "shield.lefthalf.filled"
        case .recovery: return "checkmark.circle"
        }
    }

    private func notificationColor(_ kind: AgentNotificationKind) -> Color {
        switch kind {
        case .threat: return .red
        case .monitoring: return .orange
        case .hubDelivery: return .blue
        case .threatIntelChange: return .teal
        case .recovery: return .green
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
            // Almost square. One Japanese character of extra width keeps the
            // metric subtitle on one line without materially shrinking the
            // overview panel beside it.
            globeWidth = min(topHeight + 14, width * 0.5)
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
struct AgentLogFilterBar: View {
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

/// The top-right panel: how much was seen, and how much of it can be trusted.
struct AgentOverviewPanel: View {
    let summary: AgentPeriodSummary
    let coverage: CoverageSummary
    let monitoringStatus: String
    let storage: ObservationStoreStatistics?
    let threats: ThreatReport
    /// Whether this period leans on hours whose individual records have aged
    /// out. The store answered this and the view model published it; nothing
    /// displayed it, so the connection log for an old period looked empty for
    /// no stated reason. Found on 2026-08-24 while splitting this file.
    let usesRolledUpHistory: Bool

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
                    ViewThatFits(in: .horizontal) {
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(storageDescription(storage))
                            Spacer(minLength: 8)
                            if let startedAt = storage.monitoringStartedAt {
                                Text(monitoringStartDescription(startedAt))
                                    .fixedSize(horizontal: true, vertical: false)
                            }
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            Text(storageDescription(storage))
                            if let startedAt = storage.monitoringStartedAt {
                                Text(monitoringStartDescription(startedAt))
                            }
                        }
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
            }

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
            AgentRolledUpHistoryNote(applies: usesRolledUpHistory)

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

    private static let monitoringStartFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyy/MM/dd HH:mm"
        return formatter
    }()

    private func monitoringStartDescription(_ date: Date) -> String {
        L("Monitoring started: %@", Self.monitoringStartFormatter.string(from: date))
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
    private let onClose: () -> Void

    @MainActor
    init(store: ObservationStore?, onClose: @escaping () -> Void = {}) {
        let model = AgentMainViewModel(store: store)
        self.model = model
        self.onClose = onClose
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
        // Closing the window set this false and nothing set it back, so a
        // window opened a second time stayed on its initial snapshot.
        model.isWindowVisible = true
        model.start()
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
        // Released a turn later, not here. AppKit is still closing this window
        // when `windowWillClose` runs, and the callback drops the last
        // reference to the controller that owns it.
        DispatchQueue.main.async { [onClose] in onClose() }
    }
}
