import AppKit
import EgressViewAgentCore
import SwiftUI

struct AgentInsightPanel: View {
    let snapshot: AgentLocalInsightSnapshot?
    let monitoringStatus: String
    let isRefreshing: Bool

    @State private var showsPreview = false
    @State private var copied = false
    @ObservedObject private var language = AgentLanguageSettings.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let snapshot {
                    metrics(snapshot.context)
                    changes(snapshot.context)
                    preview(snapshot)
                } else {
                    VStack(spacing: 10) {
                        Image(systemName: "chart.line.uptrend.xyaxis")
                            .font(.largeTitle)
                            .foregroundStyle(.secondary)
                        Text(L("Preparing local summary"))
                            .font(.headline)
                        Text(isRefreshing
                             ? L("Reading the selected period and the period immediately before it.")
                             : L("No local history is available for this period."))
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity, minHeight: 280)
                }
            }
            .padding(18)
        }
        .agentSection()
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: "chart.line.uptrend.xyaxis")
                .font(.title2)
                .foregroundStyle(.cyan)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(L("Local insights"))
                    .font(.title2.bold())
                Text(L("A factual summary calculated from history on this Mac."))
                    .foregroundStyle(.secondary)
                Label(monitoringStatus, systemImage: "dot.radiowaves.left.and.right")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Label(L("No AI · Insight data not sent"), systemImage: "lock.shield")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.green)
                .padding(.horizontal, 12)
                .padding(.vertical, 7)
                .background(Capsule().fill(Color.green.opacity(0.12)))
        }
    }

    private func metrics(_ context: AgentLocalInsightContext) -> some View {
        HStack(spacing: 12) {
            metricCard(
                L("Connections"), current: context.current.connections,
                previous: context.previous.connections, symbol: "point.3.connected.trianglepath.dotted"
            )
            metricCard(
                L("Applications"), current: context.current.applications,
                previous: context.previous.applications, symbol: "app.dashed"
            )
            metricCard(
                L("Destinations"), current: context.current.destinations,
                previous: context.previous.destinations, symbol: "network"
            )
            VStack(alignment: .leading, spacing: 7) {
                Label(L("Measured data"), systemImage: "arrow.up.arrow.down")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(ByteCountFormatter.string(
                    fromByteCount: Int64(clamping: context.current.measuredBytes),
                    countStyle: .binary
                ))
                .font(.system(size: 24, weight: .semibold, design: .rounded))
                Text(L("%lld connections not measured", context.current.connectionsWithoutBytes))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.75)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
            .background(cardBackground)
        }
    }

    private func metricCard(
        _ title: String, current: Int, previous: Int, symbol: String
    ) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Label(title, systemImage: symbol)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(current.formatted())
                .font(.system(size: 24, weight: .semibold, design: .rounded))
            Text(comparison(current: current, previous: previous))
                .font(.caption)
                .foregroundStyle(comparisonColor(current: current, previous: previous))
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(cardBackground)
    }

    private func changes(_ context: AgentLocalInsightContext) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(L("What changed"), systemImage: "arrow.left.arrow.right")
                .font(.headline)
            Text(changeSummary(context))
                .fixedSize(horizontal: false, vertical: true)
            if let app = context.topApplications.first {
                Text(L("Most active application: %@ (%lld connections).", displayName(app.name), app.connections))
                    .foregroundStyle(.secondary)
            }
            if let destination = context.topDestinations.first {
                Text(L("Most contacted destination: %@ (%lld connections).", displayName(destination.name), destination.connections))
                    .foregroundStyle(.secondary)
            }
            Text(L("These are counts, not a security verdict or an explanation of cause."))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardBackground)
    }

    private func preview(_ snapshot: AgentLocalInsightSnapshot) -> some View {
        DisclosureGroup(isExpanded: $showsPreview) {
            VStack(alignment: .leading, spacing: 14) {
                Text(L("This is the complete bounded context a future manual AI analysis may send. Phase 1 does not include an AI provider or a send action."))
                    .foregroundStyle(.secondary)

                VStack(alignment: .leading, spacing: 5) {
                    Label(
                        L("Period: %@ – %@",
                          previewDate(snapshot.context.periodStart),
                          previewDate(snapshot.context.periodEnd)),
                        systemImage: "calendar"
                    )
                    Label(
                        L("Fields: current and previous totals, %lld applications, %lld destinations",
                          snapshot.context.topApplications.count,
                          snapshot.context.topDestinations.count),
                        systemImage: "list.bullet.rectangle"
                    )
                }
                .font(.caption)
                .foregroundStyle(.secondary)

                HStack(alignment: .top, spacing: 24) {
                    previewList(L("Top applications"), items: snapshot.context.topApplications)
                    previewList(L("Top destinations"), items: snapshot.context.topDestinations)
                }

                HStack {
                    Label(
                        L("%lld bytes · up to %lld applications and %lld destinations",
                          snapshot.previewSizeBytes,
                          AgentLocalInsightBuilder.itemLimit,
                          AgentLocalInsightBuilder.itemLimit),
                        systemImage: "doc.text"
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    Spacer()
                    Button(copied ? L("Copied") : L("Copy preview")) {
                        copyPreview(snapshot.context)
                    }
                }

                Label(
                    L("Fields never included: raw connection rows, credentials, device notes, packet contents, account names, file paths, or browser URLs."),
                    systemImage: "hand.raised"
                )
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            .padding(.top, 12)
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                Text(L("AI context preview"))
                    .font(.headline)
                Text(L("Review exactly what could leave this Mac before any provider is enabled."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(16)
        .background(cardBackground)
    }

    private func previewList(
        _ title: String, items: [AgentLocalInsightItem]
    ) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.callout.bold())
            if items.isEmpty {
                Text(L("None recorded")).foregroundStyle(.secondary)
            } else {
                ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                    HStack {
                        Text("\(index + 1). \(displayName(item.name))")
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer()
                        Text(item.connections.formatted())
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var cardBackground: some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(Color.primary.opacity(0.055))
    }

    private func comparison(current: Int, previous: Int) -> String {
        guard previous > 0 else {
            return current > 0 ? L("No previous baseline") : L("No change")
        }
        let percent = Int((Double(current - previous) / Double(previous) * 100).rounded())
        if percent == 0 { return L("No change from previous period") }
        return L("%+lld%% vs previous period", percent)
    }

    private func comparisonColor(current: Int, previous: Int) -> Color {
        guard previous > 0, current != previous else { return .secondary }
        return .cyan
    }

    private func changeSummary(_ context: AgentLocalInsightContext) -> String {
        let current = context.current.connections
        let previous = context.previous.connections
        guard previous > 0 else {
            return current > 0
                ? L("There is no recorded activity in the previous period to compare with.")
                : L("No connections were recorded in either period.")
        }
        let percent = Int((Double(current - previous) / Double(previous) * 100).rounded())
        if abs(percent) < 10 {
            return L("Connection count was broadly stable compared with the previous period (%+lld%%).", percent)
        }
        return percent > 0
            ? L("Connection count increased by %lld%% compared with the previous period.", percent)
            : L("Connection count decreased by %lld%% compared with the previous period.", abs(percent))
    }

    private func displayName(_ value: String) -> String {
        value == "unknown" ? L("Unknown") : value
    }

    private func copyPreview(_ context: AgentLocalInsightContext) {
        guard let data = try? context.encodedPreview() else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(String(decoding: data, as: UTF8.self), forType: .string)
        copied = true
    }

    private func previewDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = language.language.locale
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
}
