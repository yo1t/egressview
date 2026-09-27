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

    public init(records: [OutboundAnomalyRecord], total: Int) {
        self.records = records
        self.total = total
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
        }
    }
}
