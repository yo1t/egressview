import EgressViewAgentCore
import Foundation

enum AgentAIProvider: String, CaseIterable, Identifiable {
    case ollama
    case openAI = "openai"

    var id: String { rawValue }
    var title: String { self == .ollama ? "Ollama" : "OpenAI" }
}

@MainActor
final class AgentOllamaController: ObservableObject {
    private enum StatusState {
        case checking
        case connected(String)
        case stopped
        case analyzing
        case completed(String)
        case invalidQuestion
        case questionSaveFailed(String)
        case newConversation
        case chooseAModel
        case noModelsInstalled
        case messageDeleted
        case historyCleared
        case deleteFailed(String)
        case configurationChanged
        case modelUnavailable(String)
        case historyUnavailable
        case invalidEndpoint
        case invalidModel
        case contextTooLarge
        case responseTooLarge
        case invalidResponse
        case httpStatus(Int)
        case emptyResponse
        case timedOut
        case cannotConnect
        case requestFailed(String)
    }

    private enum Keys {
        static let endpoint = "agentOllamaEndpoint"
        static let model = "agentOllamaModel"
        static let enabled = "agentOllamaEnabled"
        static let provider = "agentAIProvider"
        static let openAIModel = "agentOpenAIModel"
        static let openAIEnabled = "agentOpenAIEnabled"
        static let openAIConsent = "agentOpenAICloudConsent"
    }

    @Published private(set) var endpoint: String
    @Published private(set) var model: String
    @Published private(set) var isEnabled: Bool
    @Published private(set) var isRunning = false
    @Published private var statusState: StatusState?
    @Published private(set) var availableModels: [String] = []
    @Published private(set) var messages: [AgentAIConversationMessage] = []
    @Published private(set) var activeConversationID: UUID?
    @Published private(set) var provider: AgentAIProvider
    @Published private(set) var openAIModel: String
    @Published private(set) var openAIEnabled: Bool
    @Published private(set) var openAIStatus: String?

    private let defaults: UserDefaults
    private let client: AgentOllamaClient
    private let openAIClient: AgentOpenAIClient
    private let apiKeyStore: any AgentAPIKeyStoring
    private let historyStore: AgentAIConversationStore?
    private var inferenceTask: Task<Void, Never>?
    private var usageMessages: [AgentAIConversationMessage] = []

    init(
        defaults: UserDefaults = .standard,
        client: AgentOllamaClient = AgentOllamaClient(),
        openAIClient: AgentOpenAIClient = AgentOpenAIClient(),
        apiKeyStore: any AgentAPIKeyStoring = KeychainAgentAPIKeyStore(),
        historyStore: AgentAIConversationStore? = try? AgentAIConversationStore()
    ) {
        self.defaults = defaults
        self.client = client
        self.openAIClient = openAIClient
        self.apiKeyStore = apiKeyStore
        self.historyStore = historyStore
        endpoint = defaults.string(forKey: Keys.endpoint) ?? AgentOllamaConfiguration.defaultEndpoint
        model = defaults.string(forKey: Keys.model) ?? ""
        isEnabled = defaults.bool(forKey: Keys.enabled)
        provider = AgentAIProvider(rawValue: defaults.string(forKey: Keys.provider) ?? "") ?? .ollama
        openAIModel = defaults.string(forKey: Keys.openAIModel) ?? AgentOpenAIConfiguration.models[0]
        openAIEnabled = defaults.bool(forKey: Keys.openAIEnabled)
        restoreHistory()
    }

    deinit { inferenceTask?.cancel() }

    /// The models Ollama reported, plus whatever is configured.
    ///
    /// The configured name is kept even when it is not in the reported list.
    /// Dropping it would silently change which model the next question goes
    /// to, and the person would have no way to see that it happened.
    ///
    /// One definition, used by the insights screen and by Settings > AI, so
    /// the two cannot offer different lists.
    var modelChoices: [String] {
        var names = availableModels
        let configured = model.trimmingCharacters(in: .whitespaces)
        if !configured.isEmpty, !names.contains(configured) {
            names.insert(configured, at: 0)
        }
        return names
    }

    var status: String? {
        provider == .openAI ? openAIStatus : statusState.map(localized)
    }

    var isCurrentProviderEnabled: Bool { provider == .ollama ? isEnabled : openAIEnabled }

    var currentModel: String { provider == .ollama ? model : openAIModel }

    var currentModelChoices: [String] {
        provider == .ollama ? modelChoices : AgentOpenAIConfiguration.models
    }

    var currentProviderTitle: String { provider.title }

    var cloudExecutionRequiresConsent: Bool { provider == .openAI }

    var monthlyUsage: (input: Int, output: Int, cost: Double?) {
        let calendar = Calendar.current
        let now = Date()
        let rows = usageMessages.filter {
            $0.role == .assistant && calendar.isDate($0.createdAt, equalTo: now, toGranularity: .month)
        }
        let billable = rows.filter {
            $0.provider != AgentAIProvider.ollama.rawValue && ($0.inputTokens != nil || $0.outputTokens != nil)
        }
        let costs = billable.compactMap(\.estimatedCostUSD)
        return (
            rows.compactMap(\.inputTokens).reduce(0, +),
            rows.compactMap(\.outputTokens).reduce(0, +),
            costs.count == billable.count
                ? costs.reduce(0, +) : nil
        )
    }

    /// The status, but only when something is wrong.
    ///
    /// Success does not need announcing. Choosing a model from a list already
    /// shows the choice; adding "connected to Ollama, model X is available"
    /// under it said the same thing again, every time, and put a message on
    /// screen that the person had to read to discover it was nothing.
    ///
    /// Failures still need saying, so this is what the insights screen shows.
    /// Settings > AI shows the full status: that is where a person goes to
    /// change something and wants to see it took effect.
    var problem: String? {
        if provider == .openAI {
            return openAIEnabled ? nil : openAIStatus
        }
        guard let statusState else { return nil }
        switch statusState {
        case .checking, .connected, .stopped, .analyzing, .completed,
             .newConversation, .chooseAModel, .configurationChanged,
             .messageDeleted, .historyCleared:
            return nil
        case .invalidQuestion, .questionSaveFailed, .modelUnavailable,
             .noModelsInstalled, .historyUnavailable, .invalidEndpoint,
             .invalidModel, .contextTooLarge, .responseTooLarge,
             .invalidResponse, .httpStatus, .emptyResponse, .timedOut,
             .cannotConnect, .requestFailed, .deleteFailed:
            return localized(statusState)
        }
    }

    func selectProvider(_ value: AgentAIProvider) {
        guard provider != value, !isRunning else { return }
        provider = value
        defaults.set(value.rawValue, forKey: Keys.provider)
        activeConversationID = nil
    }

    func selectCurrentModel(_ value: String) {
        if provider == .ollama {
            selectModel(value)
        } else {
            guard AgentOpenAIConfiguration.models.contains(value), value != openAIModel else { return }
            openAIModel = value
            defaults.set(value, forKey: Keys.openAIModel)
            openAIEnabled = false
            defaults.set(false, forKey: Keys.openAIEnabled)
            openAIStatus = L("Save and test again after changing the model.")
        }
    }

    func saveAndTestOpenAI(apiKey: String, consent: Bool) {
        guard !isRunning else { return }
        guard consent else {
            openAIEnabled = false
            openAIStatus = L("Confirm that bounded network metadata will be sent to OpenAI.")
            return
        }
        let entered = apiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if entered.isEmpty && !openAIEnabled {
            openAIEnabled = false
            openAIStatus = L("Enter an OpenAI API key.")
            return
        }
        do { _ = try AgentOpenAIConfiguration(model: openAIModel) } catch {
            openAIEnabled = false
            openAIStatus = L("Select a supported OpenAI model.")
            return
        }
        isRunning = true
        openAIStatus = L("Checking OpenAI...")
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                let candidate = entered.isEmpty
                    ? try await apiKeyStore.loadDetached(provider: AgentAIProvider.openAI.rawValue)
                    : entered
                guard let candidate, !candidate.isEmpty else { throw AgentOpenAIError.invalidAPIKey }
                try await openAIClient.validate(apiKey: candidate, model: openAIModel)
                try Task.checkCancellation()
                try await apiKeyStore.saveDetached(candidate, provider: AgentAIProvider.openAI.rawValue)
                defaults.set(openAIModel, forKey: Keys.openAIModel)
                defaults.set(true, forKey: Keys.openAIConsent)
                defaults.set(true, forKey: Keys.openAIEnabled)
                openAIEnabled = true
                openAIStatus = L("Connected to OpenAI. Model %@ is ready.", openAIModel)
            } catch {
                openAIEnabled = false
                defaults.set(false, forKey: Keys.openAIEnabled)
                openAIStatus = cloudError(error)
            }
            isRunning = false
            inferenceTask = nil
        }
    }

    func setEndpoint(_ value: String) {
        guard endpoint != value else { return }
        endpoint = value
        invalidateConfiguration()
    }

    func setModel(_ value: String) {
        guard model != value else { return }
        model = value
        invalidateConfiguration()
    }

    /// Choosing a model from a list is the person saying they want that one.
    ///
    /// `setModel` alone switches AI off and waits to be told to check again,
    /// which is right for an endpoint typed a character at a time -- it must
    /// not connect on every keystroke. A model is picked in one action from a
    /// list Ollama itself reported, so making the person then press Save and
    /// test left AI switched off with a message explaining that they had
    /// changed something they had just deliberately changed.
    func selectModel(_ name: String) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name != model, !isRunning else { return }
        setModel(name)
        saveAndTest()
    }

    func saveAndTest() {
        guard !isRunning else { return }
        let configuration: AgentOllamaConfiguration
        do {
            configuration = try AgentOllamaConfiguration(endpoint: endpoint, model: model)
        } catch AgentOllamaError.invalidModel {
            // No model chosen yet. Ask Ollama what it has rather than
            // refusing: the person cannot pick from a list they were never
            // shown, and listing needs no model.
            listModelsForChoosing()
            return
        } catch {
            statusState = state(for: error)
            setEnabled(false)
            return
        }
        isRunning = true
        statusState = .checking
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                let models = try await client.availableModels(configuration: configuration)
                try Task.checkCancellation()
                availableModels = models
                guard AgentOllamaClient.isModel(configuration.model, availableIn: models) else {
                    throw AgentOllamaControllerError.modelUnavailable(configuration.model)
                }
                defaults.set(endpoint, forKey: Keys.endpoint)
                defaults.set(model, forKey: Keys.model)
                setEnabled(true)
                statusState = .connected(configuration.model)
            } catch is CancellationError {
                statusState = .stopped
            } catch {
                setEnabled(false)
                statusState = state(for: error)
            }
            isRunning = false
            inferenceTask = nil
        }
    }

    /// Fetch the list so the person has something to choose from.
    ///
    /// Started by pressing Save and test, so this is not the app reaching for
    /// Ollama on its own. It enables nothing: a model still has to be chosen
    /// and confirmed.
    private func listModelsForChoosing() {
        guard let url = try? AgentOllamaConfiguration.validatedEndpoint(endpoint) else {
            statusState = .invalidEndpoint
            setEnabled(false)
            return
        }
        isRunning = true
        statusState = .checking
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                availableModels = try await client.availableModels(endpoint: url)
                statusState = availableModels.isEmpty ? .noModelsInstalled : .chooseAModel
            } catch {
                statusState = state(for: error)
            }
            setEnabled(false)
            isRunning = false
            inferenceTask = nil
        }
    }

    /// Ask Ollama which models it has, without making it a whole ceremony.
    ///
    /// Only when AI is already enabled -- that is, the person has set an
    /// endpoint and confirmed the connection at least once. A Mac with no
    /// Ollama installed must not have something reaching for it because a
    /// screen was opened (P3-20: "no connection attempt on a Mac where it was
    /// never set up").
    ///
    /// Read-only and quiet: it lists models, changes no setting, and leaves
    /// the status line alone so it cannot overwrite the result of something
    /// the person actually did.
    func refreshAvailableModels() {
        guard isEnabled, !isRunning else { return }
        guard let url = try? AgentOllamaConfiguration.validatedEndpoint(endpoint) else { return }
        Task { [weak self] in
            guard let self else { return }
            guard let models = try? await client.availableModels(endpoint: url) else { return }
            availableModels = models
        }
    }

    func analyze(snapshot: AgentLocalInsightSnapshot, question: String) {
        if provider == .openAI {
            analyzeOpenAI(snapshot: snapshot, question: question)
            return
        }
        guard isEnabled, !isRunning else { return }
        let configuration: AgentOllamaConfiguration
        do {
            configuration = try AgentOllamaConfiguration(endpoint: endpoint, model: model)
        } catch {
            statusState = state(for: error)
            setEnabled(false)
            return
        }
        let cleanQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanQuestion.isEmpty, cleanQuestion.count <= 2_000 else {
            statusState = .invalidQuestion
            return
        }
        let conversationID = activeConversationID ?? UUID()
        let requestID = UUID()
        let conversationMessages = messages.filter {
            $0.conversationID == conversationID && $0.provider == AgentAIProvider.ollama.rawValue
        }
        let completedRequests = Set(conversationMessages.compactMap { message in
            message.role == .assistant && message.status == .complete ? message.requestID : nil
        })
        // A failed request has a durable user record and a failed assistant
        // record. Do not silently resend that old question on the next turn.
        let prior = conversationMessages.filter { completedRequests.contains($0.requestID) }
        let user = AgentAIConversationMessage(
            conversationID: conversationID, requestID: requestID,
            role: .user, body: cleanQuestion, model: configuration.model
        )
        do {
            try append(user)
        } catch {
            statusState = .questionSaveFailed(error.localizedDescription)
            return
        }
        activeConversationID = conversationID
        isRunning = true
        statusState = .analyzing
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                let reply = try await client.chat(
                    configuration: configuration,
                    context: snapshot.context,
                    history: prior,
                    question: cleanQuestion
                )
                try Task.checkCancellation()
                try append(AgentAIConversationMessage(
                    conversationID: conversationID, requestID: requestID,
                    role: .assistant, body: reply.text, model: configuration.model,
                    inputTokens: reply.inputTokens, outputTokens: reply.outputTokens
                ))
                statusState = .completed(configuration.model)
            } catch {
                let cancelled = isCancellation(error)
                let detail = cancelled ? "cancelled" : String(describing: type(of: error))
                try? append(AgentAIConversationMessage(
                    conversationID: conversationID, requestID: requestID,
                    role: .assistant,
                    body: cancelled ? L("Request stopped by the user.") : localized(error),
                    model: configuration.model, status: .failed, errorCode: detail
                ))
                statusState = cancelled ? .stopped : state(for: error)
            }
            isRunning = false
            inferenceTask = nil
        }
    }

    func removeOpenAIConfiguration() {
        guard !isRunning else { return }
        isRunning = true
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                try await apiKeyStore.deleteDetached(provider: AgentAIProvider.openAI.rawValue)
                openAIEnabled = false
                defaults.set(false, forKey: Keys.openAIEnabled)
                defaults.set(false, forKey: Keys.openAIConsent)
                openAIStatus = L("OpenAI API key removed from Keychain.")
            } catch {
                openAIStatus = L("Could not remove the OpenAI API key: %@", error.localizedDescription)
            }
            isRunning = false
            inferenceTask = nil
        }
    }

    private func analyzeOpenAI(snapshot: AgentLocalInsightSnapshot, question: String) {
        guard openAIEnabled, defaults.bool(forKey: Keys.openAIConsent), !isRunning else { return }
        let cleanQuestion = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanQuestion.isEmpty, cleanQuestion.count <= 2_000 else {
            openAIStatus = L("Enter a question of 2,000 characters or fewer.")
            return
        }
        let configuration: AgentOpenAIConfiguration
        do { configuration = try AgentOpenAIConfiguration(model: openAIModel) } catch {
            openAIStatus = L("Select a supported OpenAI model.")
            return
        }
        let conversationID = activeConversationID ?? UUID()
        let requestID = UUID()
        let conversationMessages = messages.filter {
            $0.conversationID == conversationID && $0.provider == AgentAIProvider.openAI.rawValue
        }
        let completedRequests = Set(conversationMessages.compactMap {
            $0.role == .assistant && $0.status == .complete ? $0.requestID : nil
        })
        let prior = conversationMessages.filter { completedRequests.contains($0.requestID) }
        do {
            try append(AgentAIConversationMessage(
                conversationID: conversationID, requestID: requestID, role: .user,
                body: cleanQuestion, provider: AgentAIProvider.openAI.rawValue, model: configuration.model
            ))
        } catch {
            openAIStatus = L("Could not save the question: %@", error.localizedDescription)
            return
        }
        activeConversationID = conversationID
        isRunning = true
        openAIStatus = L("OpenAI is analyzing the bounded preview...")
        inferenceTask = Task { [weak self] in
            guard let self else { return }
            do {
                guard let apiKey = try await apiKeyStore.loadDetached(
                    provider: AgentAIProvider.openAI.rawValue
                ) else { throw AgentOpenAIError.invalidAPIKey }
                let reply = try await openAIClient.chat(
                    configuration: configuration, apiKey: apiKey,
                    context: snapshot.context, history: prior, question: cleanQuestion
                )
                try Task.checkCancellation()
                try append(AgentAIConversationMessage(
                    conversationID: conversationID, requestID: requestID, role: .assistant,
                    body: reply.text, provider: AgentAIProvider.openAI.rawValue, model: configuration.model,
                    inputTokens: reply.inputTokens, outputTokens: reply.outputTokens,
                    estimatedCostUSD: reply.estimatedCostUSD, pricingVersion: AgentAIPriceCatalog.version
                ))
                openAIStatus = L("Analysis completed with %@.", configuration.model)
            } catch {
                let cancelled = isCancellation(error)
                if let cloud = error as? AgentOpenAIError {
                    if cloud == .invalidAPIKey || cloud == .httpStatus(401) {
                        openAIEnabled = false
                        defaults.set(false, forKey: Keys.openAIEnabled)
                    }
                }
                try? append(AgentAIConversationMessage(
                    conversationID: conversationID, requestID: requestID, role: .assistant,
                    body: cancelled ? L("Request stopped by the user.") : cloudError(error),
                    provider: AgentAIProvider.openAI.rawValue, model: configuration.model,
                    status: .failed, errorCode: cancelled ? "cancelled" : String(describing: type(of: error))
                ))
                openAIStatus = cancelled ? L("OpenAI request stopped.") : cloudError(error)
            }
            isRunning = false
            inferenceTask = nil
        }
    }

    func stop() {
        inferenceTask?.cancel()
    }

    func newConversation() {
        guard !isRunning else { return }
        activeConversationID = nil
        statusState = .newConversation
    }

    /// Delete one message, from the screen and from the file.
    ///
    /// Not blocked while a request is running: the person may want an answer
    /// gone precisely because they are looking at it.
    func deleteMessage(_ id: UUID) {
        guard let historyStore else {
            statusState = .historyUnavailable
            return
        }
        do {
            try historyStore.delete(ids: [id])
            reloadAfterDeletion()
            statusState = .messageDeleted
        } catch {
            statusState = .deleteFailed(error.localizedDescription)
        }
    }

    /// Delete every conversation. The confirmation belongs to the view; by the
    /// time this runs the person has already been asked.
    func deleteAllHistory() {
        guard let historyStore else {
            statusState = .historyUnavailable
            return
        }
        do {
            try historyStore.deleteAll()
            reloadAfterDeletion()
            statusState = .historyCleared
        } catch {
            statusState = .deleteFailed(error.localizedDescription)
        }
    }

    /// Re-read rather than mutate in place, so what the screen shows is what
    /// the file now holds.
    private func reloadAfterDeletion() {
        usageMessages = (try? historyStore?.messages(limit: 50_000)) ?? []
        messages = Array(usageMessages.suffix(500))
        if let active = activeConversationID,
           !messages.contains(where: { $0.conversationID == active }) {
            activeConversationID = nil
        }
    }

    var activeMessages: [AgentAIConversationMessage] {
        guard let activeConversationID else { return [] }
        return messages.filter { $0.conversationID == activeConversationID }
    }

    private func append(_ message: AgentAIConversationMessage) throws {
        guard let historyStore else { throw AgentOllamaControllerError.historyUnavailable }
        try historyStore.append(message)
        messages.append(message)
        if messages.count > 500 { messages.removeFirst(messages.count - 500) }
        usageMessages.append(message)
    }

    private func restoreHistory() {
        guard let restored = try? historyStore?.messages(limit: 50_000) else { return }
        usageMessages = restored
        messages = Array(restored.suffix(500))
        activeConversationID = messages.last?.conversationID
    }

    private func invalidateConfiguration() {
        setEnabled(false)
        availableModels = []
        activeConversationID = nil
        statusState = .configurationChanged
    }

    private func setEnabled(_ value: Bool) {
        isEnabled = value
        defaults.set(value, forKey: Keys.enabled)
    }

    private func state(for error: Error) -> StatusState {
        if let error = error as? AgentOllamaControllerError {
            switch error {
            case .modelUnavailable(let name): return .modelUnavailable(name)
            case .historyUnavailable: return .historyUnavailable
            }
        }
        if isCancellation(error) { return .stopped }
        if let error = error as? AgentOllamaError {
            switch error {
            case .invalidEndpoint: return .invalidEndpoint
            case .invalidModel: return .invalidModel
            case .invalidQuestion: return .invalidQuestion
            case .contextTooLarge: return .contextTooLarge
            case .responseTooLarge: return .responseTooLarge
            case .invalidResponse: return .invalidResponse
            case .httpStatus(let status): return .httpStatus(status)
            case .emptyResponse: return .emptyResponse
            }
        }
        if let urlError = error as? URLError {
            if urlError.code == .timedOut { return .timedOut }
            if urlError.code == .cannotConnectToHost || urlError.code == .networkConnectionLost {
                return .cannotConnect
            }
        }
        return .requestFailed(error.localizedDescription)
    }

    private func localized(_ error: Error) -> String {
        localized(state(for: error))
    }

    private func localized(_ state: StatusState) -> String {
        switch state {
        case .checking: return L("Checking Ollama on this Mac...")
        case .connected(let model): return L("Connected to Ollama. Model %@ is ready.", model)
        case .stopped: return L("Ollama request stopped.")
        case .analyzing: return L("Ollama is analyzing the bounded preview...")
        case .completed(let model): return L("Analysis completed locally with %@.", model)
        case .invalidQuestion: return L("Enter a question of 2,000 characters or fewer.")
        case .questionSaveFailed(let detail): return L("Could not save the question: %@", detail)
        case .newConversation: return L("New conversation ready.")
        case .chooseAModel: return L("Choose one of the models Ollama has installed.")
        case .noModelsInstalled: return L("Ollama answered, but no model is installed. Pull one with: ollama pull qwen3:8b")
        case .messageDeleted: return L("Deleted. It no longer appears in this conversation.")
        case .historyCleared: return L("All AI conversations were deleted.")
        case .deleteFailed(let reason): return L("Could not delete the history: %@", reason)
        case .configurationChanged: return L("Save and test again after changing the endpoint or model.")
        case .modelUnavailable(let name): return L("Model %@ is not installed in Ollama.", name)
        case .historyUnavailable: return L("Local AI conversation history is unavailable.")
        case .invalidEndpoint: return L("Use the local endpoint http://127.0.0.1:11434.")
        case .invalidModel: return L("Enter an installed Ollama model.")
        case .contextTooLarge: return L("The bounded preview is too large to analyze safely.")
        case .responseTooLarge: return L("Ollama returned more than the 1 MB safety limit.")
        case .invalidResponse: return L("Ollama returned a response EgressView could not read.")
        case .httpStatus(let status): return L("Ollama returned HTTP %lld.", status)
        case .emptyResponse: return L("Ollama returned an empty answer.")
        case .timedOut:
            return L("Ollama did not respond within 30 seconds. The model may still be loading; wait a moment and try again.")
        case .cannotConnect:
            return L("Could not connect to Ollama on this Mac. Start Ollama and try again.")
        case .requestFailed(let detail): return L("Ollama request failed: %@", detail)
        }
    }

    private func isCancellation(_ error: Error) -> Bool {
        if error is CancellationError { return true }
        return (error as? URLError)?.code == .cancelled
    }

    private func cloudError(_ error: Error) -> String {
        if isCancellation(error) { return L("OpenAI request stopped.") }
        if let urlError = error as? URLError, urlError.code == .timedOut {
            return L("OpenAI did not respond within 30 seconds.")
        }
        if let error = error as? AgentOpenAIError {
            switch error {
            case .invalidAPIKey: return L("Enter a valid OpenAI API key.")
            case .invalidModel: return L("Select a supported OpenAI model.")
            case .invalidQuestion: return L("Enter a question of 2,000 characters or fewer.")
            case .contextTooLarge: return L("The bounded preview is too large to analyze safely.")
            case .responseTooLarge: return L("OpenAI returned more than the 1 MB safety limit.")
            case .invalidResponse: return L("OpenAI returned a response EgressView could not read.")
            case .httpStatus(let status): return L("OpenAI returned HTTP %lld.", status)
            case .emptyResponse: return L("OpenAI returned an empty answer.")
            }
        }
        return L("OpenAI request failed: %@", error.localizedDescription)
    }
}

private enum AgentOllamaControllerError: Error {
    case modelUnavailable(String)
    case historyUnavailable
}
