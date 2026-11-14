import AppKit
import EgressViewAgentCore
import SwiftUI

/// Shows more about something when the pointer rests on it.
///
/// Half a second, so moving across the screen does not flash panels open, and
/// a popover rather than a tooltip because what it holds is a small table: a
/// tooltip is one run of text, appears after about a second, and cannot be
/// laid out.
///
/// Opened and closed by the pointer alone, through an `NSPopover` rather than
/// SwiftUI's `.popover`. That one is transient: the first click anywhere only
/// closes it, so a tile that can be clicked took two clicks once its popover
/// was open. Seen on 0.5.139 build 220.
public struct AgentHoverPopover<Detail: View>: ViewModifier {
    let isEnabled: Bool
    let detail: () -> Detail
    @State private var isShown = false
    @State private var pending: Task<Void, Never>?
    @Environment(\.locale) private var locale

    public init(isEnabled: Bool = true, @ViewBuilder detail: @escaping () -> Detail) {
        self.isEnabled = isEnabled
        self.detail = detail
    }

    public func body(content: Content) -> some View {
        content
            .onHover { inside in
                pending?.cancel()
                guard inside, isEnabled else {
                    isShown = false
                    return
                }
                pending = Task { @MainActor in
                    try? await Task.sleep(nanoseconds: 500_000_000)
                    if !Task.isCancelled { isShown = true }
                }
            }
            .onDisappear { dismiss() }
            // Nothing else closes it now, and the pointer sends no exit when
            // the app goes to the back or the window closes under it.
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didResignActiveNotification)) { _ in
                dismiss()
            }
            .onReceive(NotificationCenter.default.publisher(for: NSWindow.willCloseNotification)) { _ in
                dismiss()
            }
            .background(AgentPopoverAnchor(isShown: isShown) {
                detail()
                    .padding(14)
                    .frame(width: 400, alignment: .leading)
                    // A hosting controller starts a new environment.
                    .environment(\.locale, locale)
            })
    }

    private func dismiss() {
        pending?.cancel()
        isShown = false
    }
}

/// The view an `NSPopover` hangs from, and the popover's lifetime.
private struct AgentPopoverAnchor<Detail: View>: NSViewRepresentable {
    let isShown: Bool
    let detail: () -> Detail

    final class Coordinator {
        var popover: NSPopover?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        guard isShown else {
            context.coordinator.popover?.close()
            context.coordinator.popover = nil
            return
        }
        guard context.coordinator.popover == nil, view.window != nil else { return }
        let controller = NSHostingController(rootView: detail())
        controller.sizingOptions = [.preferredContentSize]
        let popover = NSPopover()
        popover.behavior = .applicationDefined
        popover.animates = false
        popover.contentViewController = controller
        context.coordinator.popover = popover
        popover.show(relativeTo: view.bounds, of: view, preferredEdge: .minY)
    }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        coordinator.popover?.close()
        coordinator.popover = nil
    }
}

public extension View {
    func agentHoverPopover<Detail: View>(
        isEnabled: Bool = true, @ViewBuilder detail: @escaping () -> Detail
    ) -> some View {
        modifier(AgentHoverPopover(isEnabled: isEnabled, detail: detail))
    }
}

/// One flagged 15-minute window, explained as far as what was kept allows.
public struct AgentOutboundAnomalyDetail: View {
    let record: OutboundAnomalyRecord

    public init(record: OutboundAnomalyRecord) {
        self.record = record
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(Self.kindTitle(record.kind)).font(.headline)
                Spacer()
                Text(Self.window(record)).font(.caption).foregroundStyle(.secondary)
            }
            Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 5) {
                row(L("Sent"), Self.bytes(record.bytesOut))
                if let breakdown = record.breakdown {
                    row(L("Usual for 15 minutes"), Self.bytes(breakdown.usualBytesOut))
                }
                row(L("Applications"), record.applicationCount.formatted())
                row(L("Destinations"), record.destinationCount.formatted())
            }
            .font(.callout)

            if let breakdown = record.breakdown {
                if !breakdown.applications.isEmpty {
                    contributors(L("Applications that sent the most"), breakdown.applications)
                }
                if !breakdown.destinations.isEmpty {
                    contributors(L("Destinations sent the most"), breakdown.destinations)
                    let others = breakdown.sendingDestinationCount - breakdown.destinations.count
                    if others > 0 {
                        Text(L("and %lld other destinations", others))
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }
            } else {
                // Said rather than left blank: an empty space here would read
                // as "nobody sent it".
                Text(L("Which applications and destinations sent it was not recorded for this anomaly. It was found before EgressView Agent 0.5.97, which began keeping them."))
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        GridRow {
            Text(label).foregroundStyle(.secondary)
            Text(value).monospacedDigit()
        }
    }

    private func contributors(_ title: String, _ rows: [OutboundContributor]) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack {
                    Text(row.name).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 12)
                    Text(Self.bytes(row.bytesOut)).monospacedDigit().foregroundStyle(.secondary)
                }
                .font(.callout)
            }
        }
    }

    public static func kindTitle(_ kind: OutboundAnomalyKind) -> String {
        switch kind {
        case .largeTransfer: return L("Large transfer")
        case .distributedTransfer: return L("Spread across many applications and destinations")
        }
    }

    public static func bytes(_ value: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(clamping: value), countStyle: .file)
    }

    static func window(_ record: OutboundAnomalyRecord) -> String {
        let day = DateFormatter()
        day.dateStyle = .short
        day.timeStyle = .short
        let time = DateFormatter()
        time.dateStyle = .none
        time.timeStyle = .short
        return "\(day.string(from: record.windowStart))–\(time.string(from: record.windowEnd))"
    }
}

/// The period's anomalies for the overview tile, newest first.
public struct AgentOutboundAnomalyList: View {
    let records: [OutboundAnomalyRecord]
    let total: Int
    let usual: OutboundBaselineSummary?
    let candidates: OutboundCandidateReport?

    public init(
        records: [OutboundAnomalyRecord], total: Int, usual: OutboundBaselineSummary? = nil,
        candidates: OutboundCandidateReport? = nil
    ) {
        self.records = records
        self.total = total
        self.usual = usual
        self.candidates = candidates
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Outbound anomalies in this period")).font(.title3.weight(.semibold))
            if records.isEmpty {
                Text(L("No 15-minute window in this period sent unusually much compared with this Mac's usual level."))
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                ForEach(records) { record in
                    AgentOutboundAnomalyDetail(record: record)
                    if record.id != records.last?.id { Divider() }
                }
                if total > records.count {
                    Text(L("Showing the newest %1$lld of %2$lld.", records.count, total))
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            Text(L("This is a behavioural anomaly, not a malware verdict."))
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let candidates {
                Divider()
                Text(AgentOutboundCandidatesView.summary(candidates))
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let usual {
                Divider()
                AgentOutboundBaselineView(usual: usual)
            }
        }
    }
}

/// Traffic worth a look against this Mac's usual level (P3-192, P3-193 phase
/// 2). Says what stayed out of view beside what it found, because an empty
/// list here must not read as "nothing left this Mac".
///
/// Lives in Insights, not in the overview tile's popover: fourteen days do not
/// belong beside a period picker, and a list the pointer has to rest on to see
/// is a list nobody finds. The popover keeps `summary(_:)`.
///
/// Each row is answered with the two buttons at its left, without opening it;
/// a row opens to the connections behind it and a note (P3-194 phase 1).
/// Answered rows fold into "Checked", so what is left open is what still
/// needs a look.
public struct AgentOutboundCandidatesView: View {
    /// Opens short because the AI conversation sits below it on the same screen.
    public static let collapsedCount = 10

    let report: OutboundCandidateReport
    let judgments: [String: OutboundCandidateJudgment]
    let actions: AgentOutboundCandidateActions?
    let preloadedEvidence: [String: OutboundCandidateEvidence]
    @State private var showsAll: Bool
    @State private var expandedID: String?
    @State private var showsChecked: Bool
    @State private var confirmsForget = false
    /// Notes being typed, by candidate. Kept here rather than in the opened
    /// row so the buttons on the row save what was typed below it.
    @State private var notes: [String: String] = [:]

    public init(
        report: OutboundCandidateReport, showsAll: Bool = false,
        judgments: [String: OutboundCandidateJudgment] = [:],
        actions: AgentOutboundCandidateActions? = nil,
        expandedID: String? = nil, showsChecked: Bool = false,
        preloadedEvidence: [String: OutboundCandidateEvidence] = [:]
    ) {
        self.report = report
        self.judgments = judgments
        self.actions = actions
        self.preloadedEvidence = preloadedEvidence
        _showsAll = State(initialValue: showsAll)
        _expandedID = State(initialValue: expandedID)
        _showsChecked = State(initialValue: showsChecked)
    }

    /// One line for the overview tile. A low share keeps its warning here,
    /// because a count alone would read as all there is.
    public static func summary(_ report: OutboundCandidateReport) -> String {
        switch report.state {
        case .learning:
            return L("Worth a look: still learning this Mac, so nothing can be judged yet.")
        case .lowByteCoverage:
            return L("Worth a look: %lld in the last 14 days, and unusual amounts can be missed here. Click this card to open Insights.", report.total)
        case .ready:
            return report.total == 0
                ? L("Worth a look: nothing stood out in the last 14 days.")
                : L("Worth a look: %lld in the last 14 days. Click this card to open the list in Insights.", report.total)
        }
    }

    private var unchecked: [OutboundCandidate] {
        report.candidates.filter { judgments[$0.id] == nil }
    }

    private var checked: [OutboundCandidate] {
        report.candidates.filter { judgments[$0.id] != nil }
    }

    private var visible: [OutboundCandidate] {
        showsAll ? unchecked : Array(unchecked.prefix(Self.collapsedCount))
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label(L("Worth a look (last 14 days)"), systemImage: "magnifyingglass").font(.headline)
            switch report.state {
            case .learning(let hours):
                note(L(
                    "Still learning this Mac: %1$@ of %2$lld monitored hours. Until then nothing can be judged, which is not the same as nothing unusual.",
                    hours.formatted(.number.precision(.fractionLength(1))),
                    OutboundCandidateRules.learningSeconds / 3600
                ))
            case .lowByteCoverage(let share):
                note(L(
                    "Only %lld%% of recent connections have a byte count, so unusual amounts can be missed here. Counting from packet headers in Settings raises it.",
                    Int((share * 100).rounded())
                ))
            case .ready:
                EmptyView()
            }
            if case .learning = report.state {} else {
                if report.candidates.isEmpty {
                    note(L("Nothing stood out against this Mac's usual traffic."))
                } else if unchecked.isEmpty {
                    note(L("You have answered every one listed here."))
                }
                ForEach(visible) { candidate in row(candidate) }
                if visible.count < unchecked.count {
                    Button(L("Show all %lld", unchecked.count)) { showsAll = true }
                        .buttonStyle(.plain)
                        .foregroundStyle(.tint)
                        .font(.caption)
                } else if report.total > report.candidates.count {
                    Text(L("Showing the newest %1$lld of %2$lld.", report.candidates.count, report.total))
                        .font(.caption).foregroundStyle(.secondary)
                }
                if !checked.isEmpty {
                    DisclosureGroup(isExpanded: $showsChecked) {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(checked) { candidate in row(candidate) }
                            if actions != nil {
                                Button(L("Forget all answers…")) { confirmsForget = true }
                                    .buttonStyle(.plain)
                                    .foregroundStyle(.tint)
                                    .font(.caption)
                            }
                        }
                        .padding(.top, 4)
                    } label: {
                        Text(L("Checked (%lld)", checked.count)).font(.callout)
                    }
                }
                note(L("A place to start looking, not a verdict: your own uploads and updates appear here too. Small amounts, browsers, virtual machines and transfers within your network are not judged."))
            }
        }
        // A name here is what gets searched for or passed on next.
        .textSelection(.enabled)
        .confirmationDialog(
            L("Forget all answers?"), isPresented: $confirmsForget
        ) {
            Button(L("Forget all answers"), role: .destructive) { actions?.forgetAll() }
        } message: {
            Text(L("Every candidate goes back to the list, and the notes are deleted. The candidates themselves are not changed."))
        }
    }

    @ViewBuilder
    private func row(_ candidate: OutboundCandidate) -> some View {
        let isExpanded = expandedID == candidate.id
        let judgment = judgments[candidate.id]
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: 8) {
                if let actions {
                    HStack(spacing: 4) {
                        verdictButton(.expected, candidate: candidate, judgment: judgment, actions: actions)
                        verdictButton(.investigate, candidate: candidate, judgment: judgment, actions: actions)
                    }
                    .fixedSize()
                }
                // Outside the buttons, so pressing one answers without
                // opening the row.
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if actions != nil {
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.right")
                            .font(.caption2).foregroundStyle(.secondary)
                            .frame(width: 10)
                    }
                    // Why it is listed sits under the name, so it is read
                    // without opening the row.
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title(candidate)).font(.callout)
                        Text(detail(candidate)).font(.caption).foregroundStyle(.secondary)
                        Text(AgentOutboundCandidateDetail.reason(candidate))
                            .font(.caption)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 8)
                    if actions == nil, let judgment {
                        Text(Self.verdictLabel(judgment.verdict))
                            .font(.caption)
                            .foregroundStyle(judgment.verdict == .investigate ? Color.orange : Color.secondary)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard actions != nil else { return }
                    expandedID = isExpanded ? nil : candidate.id
                }
                .accessibilityAddTraits(actions != nil ? .isButton : [])
            }
            if isExpanded, let actions {
                AgentOutboundCandidateDetail(
                    candidate: candidate, judgment: judgment, actions: actions,
                    preloaded: preloadedEvidence[candidate.id],
                    note: noteBinding(candidate),
                    takeBack: { notes[candidate.id] = nil }
                )
                .padding(.leading, 16)
                .padding(.vertical, 4)
            }
        }
    }

    private func noteBinding(_ candidate: OutboundCandidate) -> Binding<String> {
        Binding(
            get: { notes[candidate.id] ?? judgments[candidate.id]?.note ?? "" },
            set: { notes[candidate.id] = $0 }
        )
    }

    /// The chosen answer is filled in, so a row in "Checked" shows which it
    /// was; pressing it again saves an edited note.
    @ViewBuilder
    private func verdictButton(
        _ verdict: OutboundCandidateVerdict, candidate: OutboundCandidate,
        judgment: OutboundCandidateJudgment?, actions: AgentOutboundCandidateActions
    ) -> some View {
        let label = Self.verdictLabel(verdict)
        let save = { actions.judge(candidate, verdict, noteBinding(candidate).wrappedValue) }
        Group {
            if judgment?.verdict == verdict {
                Button(label, action: save).buttonStyle(.borderedProminent)
                    .tint(verdict == .investigate ? .orange : .accentColor)
            } else {
                Button(label, action: save).buttonStyle(.bordered)
            }
        }
        .controlSize(.small)
        .accessibilityLabel("\(label): \(title(candidate))")
    }

    static func verdictLabel(_ verdict: OutboundCandidateVerdict) -> String {
        switch verdict {
        case .expected: return L("Expected")
        case .investigate: return L("Look into it")
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func title(_ candidate: OutboundCandidate) -> String {
        guard let application = candidate.application, let destination = candidate.destination else {
            return L("This Mac as a whole")
        }
        return "\(application) → \(destination)"
    }

    private func detail(_ candidate: OutboundCandidate) -> String {
        let day = candidate.at.formatted(date: .abbreviated, time: .omitted)
        let sent = AgentOutboundBaselineView.bytes(candidate.bytesOut)
        let usual = AgentOutboundBaselineView.bytes(candidate.usualBytesOut ?? 0)
        switch candidate.kind {
        case .newPair: return L("%1$@: first time together, %2$@ sent within a week", day, sent)
        case .aboveUsual: return L("%1$@: %2$@ sent in a day, usually up to %3$@", day, sent, usual)
        case .machine: return L("%1$@: %2$@ sent in 24 hours, usually up to %3$@", day, sent, usual)
        }
    }
}

/// What the candidate list can ask of the app. Absent, rows do not open --
/// as in the overview tile and the render check of the plain list.
public struct AgentOutboundCandidateActions {
    public var loadEvidence: @Sendable (OutboundCandidate) async -> OutboundCandidateEvidence?
    public var judge: @MainActor (OutboundCandidate, OutboundCandidateVerdict?, String) -> Void
    public var forgetAll: @MainActor () -> Void

    public init(
        loadEvidence: @escaping @Sendable (OutboundCandidate) async -> OutboundCandidateEvidence?,
        judge: @escaping @MainActor (OutboundCandidate, OutboundCandidateVerdict?, String) -> Void,
        forgetAll: @escaping @MainActor () -> Void = {}
    ) {
        self.loadEvidence = loadEvidence
        self.judge = judge
        self.forgetAll = forgetAll
    }
}

/// One candidate opened: the connections behind it, how much of that time
/// could be seen, and a note for the answer (P3-194 phase 1).
struct AgentOutboundCandidateDetail: View {
    let candidate: OutboundCandidate
    let judgment: OutboundCandidateJudgment?
    let actions: AgentOutboundCandidateActions
    let preloaded: OutboundCandidateEvidence?

    private enum Loaded { case loading, failed, done(OutboundCandidateEvidence) }
    @State private var loaded: Loaded
    @Binding private var noteText: String
    private let takeBack: () -> Void
    /// The person's choice in Settings > Hub (P3-194), read here so this
    /// screen says where an answer goes whenever it is typed.
    @AppStorage(OutboundCandidateSharingPreferences.enabledKey) private var sharesWithHub = false
    @AppStorage(OutboundCandidateSharingPreferences.includesNotesKey) private var sharesNotesWithHub = false

    init(
        candidate: OutboundCandidate, judgment: OutboundCandidateJudgment?,
        actions: AgentOutboundCandidateActions, preloaded: OutboundCandidateEvidence?,
        note: Binding<String>, takeBack: @escaping () -> Void
    ) {
        self.candidate = candidate
        self.judgment = judgment
        self.actions = actions
        self.preloaded = preloaded
        self.takeBack = takeBack
        _loaded = State(initialValue: preloaded.map { .done($0) } ?? .loading)
        _noteText = note
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Why it is listed is on the row itself, open or not.
            evidence
            Divider()
            answer
        }
        .task(id: candidate.id) {
            if preloaded != nil { return }
            loaded = .loading
            if let value = await actions.loadEvidence(candidate) {
                loaded = .done(value)
            } else {
                loaded = .failed
            }
        }
    }

    @ViewBuilder
    private var evidence: some View {
        switch loaded {
        case .loading:
            HStack(spacing: 6) {
                ProgressView().controlSize(.small)
                caption(L("Reading the connections…"))
            }
        case .failed:
            caption(L("The connections could not be read."))
        case .done(let evidence):
            VStack(alignment: .leading, spacing: 4) {
                Text(L("Connections behind it")).font(.caption.weight(.semibold))
                if evidence.flows.isEmpty {
                    caption(L("No connection is left in the history for this time."))
                }
                ForEach(evidence.flows) { flow in
                    flowRow(flow)
                }
                if evidence.flowTotal > evidence.flows.count {
                    caption(L("Showing the largest %1$lld of %2$lld.", evidence.flows.count, evidence.flowTotal))
                }
                caption(L(
                    "Monitored %1$lld%% of %2$@.",
                    Int((Double(evidence.monitoredSeconds) / max(1, evidence.window.duration) * 100).rounded()),
                    Self.windowText(evidence.window)
                ))
                if evidence.mayUndercount {
                    caption(L("Part of this time was not monitored, had no byte count, or is no longer kept connection by connection, so more may have been sent than shown."))
                }
            }
        }
    }

    private func flowRow(_ flow: OutboundCandidateEvidence.Flow) -> some View {
        let name = flow.hostname ?? flow.address
        let place = flow.hostname == nil ? "" : " (\(flow.address))"
        let app = candidate.application == nil ? "\(flow.application) → " : ""
        return VStack(alignment: .leading, spacing: 1) {
            Text("\(app)\(name)\(place)").font(.caption)
            Text(L(
                "%1$@ sent over %2$lld connections, %3$@",
                AgentOutboundBaselineView.bytes(flow.bytesOut), flow.connections,
                Self.spanText(flow.firstAt, flow.lastAt)
            ))
            .font(.caption2).foregroundStyle(.secondary)
        }
    }

    private var answer: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(L("Note (optional)"), text: $noteText, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .font(.caption)
                .lineLimit(1...3)
            if let judgment {
                HStack(spacing: 12) {
                    if noteText != judgment.note {
                        Button(L("Save note")) { actions.judge(candidate, judgment.verdict, noteText) }
                            .buttonStyle(.bordered).controlSize(.small)
                    }
                    Button(L("Take back")) {
                        takeBack()
                        actions.judge(candidate, nil, "")
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(.tint)
                    .font(.caption)
                }
            } else {
                caption(L("Answer with the buttons at the left of the row; a note typed here goes with it."))
            }
            caption(L("Your answer and note are kept on this Mac. They go to an AI provider only with a question you send, and the AI context preview shows them first."))
            if sharesWithHub {
                caption(sharesNotesWithHub
                    ? L("Sending to the Hub is on: this list, your answers and your notes also go to the Hub. Change it in Settings > Hub.")
                    : L("Sending to the Hub is on: this list and your answers also go to the Hub, without your notes. Change it in Settings > Hub."))
            }
        }
    }

    private func caption(_ text: String) -> some View {
        Text(text).font(.caption).foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Why it is on the list, in one sentence, with the yardstick it was
    /// held against.
    static func reason(_ candidate: OutboundCandidate) -> String {
        let day = candidate.at.formatted(date: .abbreviated, time: .omitted)
        let sent = AgentOutboundBaselineView.bytes(candidate.bytesOut)
        let usual = AgentOutboundBaselineView.bytes(candidate.usualBytesOut ?? 0)
        let app = candidate.application ?? ""
        let destination = candidate.destination ?? ""
        switch candidate.kind {
        case .newPair:
            return L("%1$@ had not sent to %2$@ before this Mac's usual was learned. In the week up to %3$@ it sent %4$@, past the 1 MB at which a new pair is listed.", app, destination, day, sent)
        case .aboveUsual:
            return L("On %1$@, %2$@ sent %3$@ to %4$@. On most days it sends up to %5$@; a day is listed at 10 MB and five times that.", day, app, sent, destination, usual)
        case .machine:
            return L("In 24 hours on %1$@ this Mac sent %2$@. Its usual 24 hours reach up to %3$@; it is listed above one and a half times that.", day, sent, usual)
        }
    }

    /// Named by the days it covers, as the list names the candidate's day:
    /// the window ends a day after that day starts.
    static func windowText(_ window: DateInterval) -> String {
        let end = window.end.addingTimeInterval(-86_400)
        let first = window.start.formatted(date: .abbreviated, time: .omitted)
        let last = end.formatted(date: .abbreviated, time: .omitted)
        return first == last ? first : "\(first)–\(last)"
    }

    static func spanText(_ first: Date, _ last: Date) -> String {
        let start = first.formatted(date: .abbreviated, time: .shortened)
        let end = Calendar.current.isDate(first, inSameDayAs: last)
            ? last.formatted(date: .omitted, time: .shortened)
            : last.formatted(date: .abbreviated, time: .shortened)
        return start == end ? start : "\(start)–\(end)"
    }
}

/// What the Agent has learned about this Mac's usual traffic, and how well it
/// can measure here (P3-192 phase 1).
///
/// Counted in monitored hours, because that is what the learning is made of:
/// a Mac that sleeps most of the week has a few hours, and saying "seven
/// days" would claim history it does not have. The share of destinations
/// with a name is shown beside it because it differs by machine -- 82.5% on
/// one Mac, 44.6% on a Windows PC -- and it decides how well "a destination
/// this app has not used before" can be told.
public struct AgentOutboundBaselineView: View {
    let usual: OutboundBaselineSummary

    public init(usual: OutboundBaselineSummary) { self.usual = usual }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("Usual on this Mac")).font(.headline)
            if usual.hoursRecorded == 0 {
                Text(L("Nothing learned yet. The Agent counts only the hours it was monitoring, an hour at a time."))
                    .font(.callout).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                row(L("Learned from"), L(
                    "%1$@ monitored hours (since %2$@)",
                    usual.monitoredHours.formatted(.number.precision(.fractionLength(1))),
                    usual.since.map { $0.formatted(date: .abbreviated, time: .omitted) } ?? "—"
                ))
                row(L("Sent per hour"), usual.fullyMonitoredHours == 0
                    ? L("No fully monitored hour yet")
                    : L(
                        "median %1$@, 99th percentile %2$@ (over %3$lld fully monitored hours)",
                        Self.bytes(usual.hourlyMedianBytesOut), Self.bytes(usual.hourlyP99BytesOut),
                        usual.fullyMonitoredHours
                    ))
                row(L("Destinations with a name"),
                    usual.namedShare.map { "\(Int(($0 * 100).rounded()))%" } ?? "—")
                row(L("App and destination pairs seen"), usual.pairsKnown.formatted())
            }
        }
    }

    private func row(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text(label).foregroundStyle(.secondary)
            Spacer(minLength: 12)
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.callout)
    }

    static func bytes(_ value: UInt64) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(clamping: value), countStyle: .file)
    }
}
