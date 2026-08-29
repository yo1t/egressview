import AppKit
import EgressViewAgentCore
import SwiftUI

// Destinations that matched a threat feed, and the honest account of what was
// checked to produce that list.

/// The threats tab.
///
/// Its most important job is the one that shows nothing: saying "nobody
/// looked" rather than "nothing found". An empty list from a screen that never
/// had indicators would present an unexamined period as a clean one, which is
/// the same failure as an empty chart reading as a quiet network.
struct AgentThreatPanel: View {
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
                    HStack(spacing: 6) {
                        // Low confidence is marked, not hidden. A file hosted
                        // on a service people use all day is worth seeing and
                        // not worth interrupting anyone about (P3-19).
                        Image(systemName: finding.confidence == .high
                              ? "exclamationmark.triangle.fill" : "questionmark.circle")
                            .foregroundStyle(finding.confidence == .high ? Color.orange : Color.secondary)
                            .accessibilityLabel(finding.confidence == .high
                                                ? L("Match worth acting on")
                                                : L("Low confidence match"))
                        Text(finding.candidate.hostname ?? finding.candidate.address)
                            .monospaced()
                    }
                    .help(Self.tooltip(for: finding))
                }
                .width(min: 190, ideal: 260)
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

func formattedMetric(_ value: Double, _ metric: TrafficMetric) -> String {
    switch metric {
    case .sessions:
        return Int(value).formatted()
    case .bytes:
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }
}
