import EgressViewAgentCore
import SwiftUI

/// Shows more about something when the pointer rests on it.
///
/// Half a second, so moving across the screen does not flash panels open, and
/// a popover rather than a tooltip because what it holds is a small table: a
/// tooltip is one run of text, appears after about a second, and cannot be
/// laid out.
public struct AgentHoverPopover<Detail: View>: ViewModifier {
    let isEnabled: Bool
    let detail: () -> Detail
    @State private var isShown = false
    @State private var pending: Task<Void, Never>?

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
            .onDisappear { pending?.cancel() }
            .popover(isPresented: $isShown, arrowEdge: .bottom) {
                detail()
                    .padding(14)
                    .frame(width: 400, alignment: .leading)
            }
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
                AgentOutboundCandidatesView(report: candidates)
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
public struct AgentOutboundCandidatesView: View {
    let report: OutboundCandidateReport

    public init(report: OutboundCandidateReport) { self.report = report }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("Worth a look (last 14 days)")).font(.headline)
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
                }
                ForEach(report.candidates) { candidate in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title(candidate)).font(.callout)
                        Text(detail(candidate)).font(.caption).foregroundStyle(.secondary)
                    }
                }
                if report.total > report.candidates.count {
                    Text(L("Showing the newest %1$lld of %2$lld.", report.candidates.count, report.total))
                        .font(.caption).foregroundStyle(.secondary)
                }
                note(L("A place to start looking, not a verdict: your own uploads and updates appear here too. Small amounts, browsers, virtual machines and transfers within your network are not judged."))
            }
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
