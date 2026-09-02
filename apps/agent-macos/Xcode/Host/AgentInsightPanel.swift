import AppKit
import EgressViewAgentCore
import SwiftUI

struct AgentInsightPanel: View {
    let snapshot: AgentLocalInsightSnapshot?
    let monitoringStatus: String
    let isRefreshing: Bool
    @ObservedObject var ollama: AgentOllamaController

    @State private var question = ""
    @State private var confirmsClearAll = false
    @State private var showsPreview = false
    @State private var copied = false
    @State private var pendingCloudQuestion: String?
    @ObservedObject private var language = AgentLanguageSettings.shared

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                header
                if let snapshot {
                    metrics(snapshot.context)
                    changes(snapshot.context)
                    preview(snapshot)
                    conversation(snapshot)
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
        .task(id: ollama.isEnabled) { ollama.refreshAvailableModels() }
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
            VStack(alignment: .trailing, spacing: 8) {
                // One badge. It says the ordinary thing, and says the problem
                // instead when there is one -- rather than a second line
                // announcing every success beneath it.
                if let problem = ollama.problem {
                    Label(problem, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.orange)
                        .multilineTextAlignment(.trailing)
                        .lineLimit(3)
                        .textSelection(.enabled)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.orange.opacity(0.12)))
                        .frame(maxWidth: 380, alignment: .trailing)
                } else {
                    Label(
                        ollama.isCurrentProviderEnabled
                            ? providerReadyLabel
                            : L("AI off · Insight data not sent"),
                        systemImage: "lock.shield"
                    )
                        .font(.callout.weight(.semibold))
                        .foregroundStyle(.green)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(Capsule().fill(Color.green.opacity(0.12)))
                }
                modelPickers
            }
        }
    }

    /// Which model answers, beside the badge that says whether it can.
    ///
    /// No card of its own: the badge above already says which provider is
    /// ready, so a separate provider card would repeat the same state.
    ///
    private var modelPickers: some View {
        HStack(spacing: 8) {
            Picker(L("Provider"), selection: providerBinding) {
                ForEach(AgentAIProvider.allCases) { provider in
                    Text(provider.title).tag(provider)
                }
            }
            .labelsHidden()
            .frame(width: 110)
            .disabled(ollama.isRunning)

            Picker(L("Model"), selection: modelBinding) {
                if ollama.currentModelChoices.isEmpty {
                    Text(L("No model selected")).tag("")
                }
                ForEach(ollama.currentModelChoices, id: \.self) { name in
                    Text(name).tag(name)
                }
            }
            .labelsHidden()
            .frame(width: 190)
            .disabled(ollama.isRunning)
        }
        .controlSize(.small)
    }

    private var providerBinding: Binding<AgentAIProvider> {
        Binding(get: { ollama.provider }, set: { ollama.selectProvider($0) })
    }

    private var modelBinding: Binding<String> {
        Binding(get: { ollama.currentModel }, set: { ollama.selectCurrentModel($0) })
    }

    private func conversation(_ snapshot: AgentLocalInsightSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Label(L("Ask about this period"), systemImage: "text.bubble")
                    .font(.headline)
                Spacer()
                Button(L("New conversation")) { ollama.newConversation() }
                    .disabled(ollama.isRunning)
                Button(L("Delete all"), role: .destructive) { confirmsClearAll = true }
                    .disabled(ollama.messages.isEmpty)
            }

            if !ollama.isCurrentProviderEnabled {
                Text(L("Choose and configure an AI provider in Settings > AI."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            // The box you type in sits above the answers: the thing you came
            // to do should not be below a conversation that grows every time
            // you do it.
            TextField(L("Ask about the bounded preview"), text: $question, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(2...5)
                .disabled(ollama.isRunning || !ollama.isCurrentProviderEnabled)
            HStack {
                Button(L("Analyze current period")) {
                    submit(
                        L("Summarize the notable changes and suggest proportionate checks. Do not infer facts not present in the aggregates."),
                        snapshot: snapshot
                    )
                }
                .disabled(ollama.isRunning || !ollama.isCurrentProviderEnabled)
                Button(L("Ask")) {
                    let submitted = question
                    submit(submitted, snapshot: snapshot)
                }
                .disabled(
                    ollama.isRunning || !ollama.isCurrentProviderEnabled
                        || question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
                if ollama.isRunning {
                    ProgressView().controlSize(.small)
                    Button(L("Stop"), role: .destructive) { ollama.stop() }
                }
                Spacer()
                Label(L("30 second limit · one request at a time"), systemImage: "timer")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Divider()

            usageSummary

            if ollama.activeMessages.isEmpty {
                Text(L("No local AI messages yet. Start with a factual analysis or enter a question."))
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, minHeight: 70, alignment: .center)
            } else {
                // Newest exchange first, so the answer to what you just
                // asked is next to the box you asked it in -- but a question
                // and its answer stay in the order they happened. Reversing
                // every message put each answer above its own question.
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(exchanges, id: \.id) { exchange in
                        VStack(alignment: .leading, spacing: 10) {
                            ForEach(exchange.messages) { message in
                                messageRow(message)
                            }
                        }
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(cardBackground)
        .confirmationDialog(
            L("Delete every AI conversation on this Mac?"),
            isPresented: $confirmsClearAll,
            titleVisibility: .visible
        ) {
            Button(L("Delete all"), role: .destructive) { ollama.deleteAllHistory() }
            Button(L("Cancel"), role: .cancel) { }
        } message: {
            Text(L("%lld messages will be deleted. This cannot be undone.", ollama.messages.count))
        }
        .alert(cloudConfirmationTitle, isPresented: cloudConfirmationPresented) {
            Button(L("Cancel"), role: .cancel) { pendingCloudQuestion = nil }
            Button(cloudSendButtonTitle) {
                guard let pendingCloudQuestion else { return }
                question = ""
                ollama.analyze(snapshot: snapshot, question: pendingCloudQuestion)
                self.pendingCloudQuestion = nil
            }
        } message: {
            Text(L(
                "The preview contains totals, time range, up to %lld application names, and up to %lld destination names or addresses. It will be sent to %@ and may incur API charges. No API key or raw connection rows are included.",
                snapshot.context.topApplications.count, snapshot.context.topDestinations.count,
                ollama.currentProviderTitle
            ))
        }
    }

    private func submit(_ value: String, snapshot: AgentLocalInsightSnapshot) {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        if ollama.cloudExecutionRequiresConsent {
            pendingCloudQuestion = clean
        } else {
            question = ""
            ollama.analyze(snapshot: snapshot, question: clean)
        }
    }

    private var cloudConfirmationPresented: Binding<Bool> {
        Binding(
            get: { pendingCloudQuestion != nil },
            set: { if !$0 { pendingCloudQuestion = nil } }
        )
    }

    private var usageSummary: some View {
        let usage = ollama.monthlyUsage
        return HStack(spacing: 8) {
            Label(
                L("This month: %lld input · %lld output tokens", usage.input, usage.output),
                systemImage: "gauge.with.dots.needle.50percent"
            )
            if let cost = usage.cost {
                Text(String(format: L("Estimated USD %.4f"), cost))
            } else if usage.input > 0 || usage.output > 0 {
                Text(L("Estimated cost unknown"))
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
    }

    private struct Exchange: Identifiable {
        let id: UUID
        let messages: [AgentAIConversationMessage]
    }

    /// One question and its answer, grouped by the request that produced them.
    private var exchanges: [Exchange] {
        var order: [UUID] = []
        var grouped: [UUID: [AgentAIConversationMessage]] = [:]
        for message in ollama.activeMessages {
            if grouped[message.requestID] == nil { order.append(message.requestID) }
            grouped[message.requestID, default: []].append(message)
        }
        return order.reversed().map { Exchange(id: $0, messages: grouped[$0] ?? []) }
    }

    private func messageRow(_ message: AgentAIConversationMessage) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(message.role == .user ? L("You") : providerName(message.provider))
                    .font(.caption.bold())
                Spacer()
                Text(message.createdAt, style: .time)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                // Offered on questions too, not only answers: a question can
                // be the part someone wants gone.
                Button(L("Delete")) { ollama.deleteMessage(message.id) }
                    .buttonStyle(.borderless)
                    .font(.caption)
                    .accessibilityLabel(
                        message.role == .user
                            ? L("Delete this question")
                            : L("Delete this answer")
                    )
            }
            Text(message.body)
                .textSelection(.enabled)
                .foregroundStyle(message.status == .failed ? Color.orange : Color.primary)
            if let input = message.inputTokens, let output = message.outputTokens {
                Text(L("Tokens: %lld input · %lld output", input, output))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            if message.role == .assistant {
                HStack(spacing: 5) {
                    Text("\(providerName(message.provider)) · \(message.model)")
                    if let cost = message.estimatedCostUSD {
                        Text(String(format: L("Estimated USD %.6f"), cost))
                    } else if message.inputTokens != nil || message.outputTokens != nil {
                        Text(L("Estimated cost unknown"))
                    }
                }
                .font(.caption2)
                .foregroundStyle(.secondary)
            }
        }
        .padding(10)
        .background(
            (message.role == .user ? Color.blue : Color.primary).opacity(0.07),
            in: RoundedRectangle(cornerRadius: 9)
        )
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
                Text(ollama.provider == .ollama
                     ? L("This is the complete bounded context sent only when you manually ask the configured local Ollama model.")
                     : L("This is the complete bounded context sent to %@ only after you confirm each request.", ollama.currentProviderTitle))
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

    private func providerName(_ value: String) -> String {
        AgentAIProvider(rawValue: value)?.title ?? value
    }

    private var providerReadyLabel: String {
        switch ollama.provider {
        case .ollama: L("Ollama ready · Local only")
        case .anthropic: L("Anthropic ready · Manual cloud send")
        case .openAI: L("OpenAI ready · Manual cloud send")
        }
    }

    private var cloudConfirmationTitle: String {
        L("Send bounded network metadata to %@?", ollama.currentProviderTitle)
    }

    private var cloudSendButtonTitle: String {
        L("Send to %@", ollama.currentProviderTitle)
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
