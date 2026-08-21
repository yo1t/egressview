import AppKit
import EgressViewAgentCore
import Network
import SwiftUI

@MainActor
final class HubDeliveryController: ObservableObject {
    @Published var hubAddress = ""
    @Published var enrollmentCode = ""
    @Published var consentConfirmed = false
    @Published private(set) var enrolledHub = L("Not enrolled")
    @Published private(set) var deliveryEnabled = false
    @Published private(set) var canEnableDelivery = false
    @Published private(set) var isEnrolling = false
    @Published private(set) var status = L("Delivery is off")
    @Published private(set) var pending = L(
        "Pending: %lld · invalid: %lld · overflow: %lld · prior unclassified: %lld",
        0, 0, 0, 0
    )
    @Published private(set) var oldestPending = L("Oldest pending: %@", L("none"))
    @Published private(set) var lastAcknowledged = L("Last acknowledged: %@", L("never"))
    @Published var errorMessage: String?

    private let credentialStore = KeychainAgentCredentialStore()
    private let preferences = AgentDeliveryPreferences()
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "com.egressview.agent.hub-connectivity")
    private var deliverySampler = ObservationPersistenceSampler(refreshInterval: 60)
    private lazy var sender: AgentIngestSender? = makeSender()
    private var senderState: AgentIngestSenderState = .off

    init() {
        _ = sender
        restore()
        startConnectivityMonitor()
    }

    deinit {
        networkMonitor.cancel()
    }

    func refresh() {
        restore()
    }

    func enqueue(_ observations: [ConnectionObservation]) {
        guard preferences.isEnabled else { return }
        let sampled = deliverySampler.observationsToPersist(observations)
        guard !sampled.isEmpty else { return }
        Task { await sender?.enqueue(sampled) }
    }

    func requestAccess() {
        guard consentConfirmed else {
            errorMessage = L("Review the data summary and confirm consent before enrolling.")
            return
        }
        guard let hubURL = URL(string: hubAddress.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            errorMessage = L("Enter a valid Hub URL.")
            return
        }

        let code = enrollmentCode.trimmingCharacters(in: .whitespacesAndNewlines)
        isEnrolling = true
        let metadata = AgentEnrollmentMetadata(
            hostName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            platform: "macos",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        )
        Task {
            let service = AgentEnrollmentService(credentialStore: credentialStore)
            do {
                let ticket = try await service.apply(hubURL: hubURL, code: code, metadata: metadata)
                enrollmentCode = ""
                enrolledHub = L("Waiting for approval on %@", ticket.hubURL.absoluteString)
                let credential = try await service.waitForApproval(ticket: ticket)
                enrolledHub = L("Enrolled Hub: %@", credential.hubURL.absoluteString)
                canEnableDelivery = sender != nil
                deliveryEnabled = false
                preferences.isEnabled = false
                isEnrolling = false
                await sender?.setEnabled(false)
                await sender?.credentialDidChange()
            } catch {
                isEnrolling = false
                errorMessage = Self.enrollmentMessage(for: error)
            }
        }
    }

    func setDeliveryEnabled(_ enabled: Bool) {
        guard !enabled || consentConfirmed else {
            deliveryEnabled = false
            errorMessage = L("Confirm the delivery summary before enabling delivery.")
            return
        }
        guard !enabled || canEnableDelivery else {
            deliveryEnabled = false
            errorMessage = L("Enroll this Mac with a Hub before enabling delivery.")
            return
        }
        deliveryEnabled = enabled
        preferences.isEnabled = enabled
        Task { await sender?.setEnabled(enabled) }
    }

    func sendNow() {
        Task { await sender?.sendNow() }
    }

    func stopForUninstall() async {
        deliveryEnabled = false
        preferences.isEnabled = false
        await sender?.pause()
    }

    private func makeSender() -> AgentIngestSender? {
        let queue: AgentDeliveryQueue
        do {
            queue = try AgentDeliveryQueue()
        } catch {
            status = L("Delivery unavailable: the private pending queue could not be opened")
            canEnableDelivery = false
            return nil
        }
        let metadata = AgentIngestMetadata(
            hostName: Host.current().localizedName ?? ProcessInfo.processInfo.hostName,
            platform: .macOS,
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            agentVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
        )
        return AgentIngestSender(
            queue: queue,
            credentialStore: credentialStore,
            metadata: metadata,
            statusHandler: { [weak self] state, queueStatus in
                Task { @MainActor in self?.render(state: state, queueStatus: queueStatus) }
            }
        )
    }

    private func restore() {
        Task {
            let credentialStore = credentialStore
            let credential = await credentialStore.loadDetached()
            let senderAvailable = sender != nil
            hubAddress = credential?.hubURL.absoluteString ?? hubAddress
            enrolledHub = credential.map { L("Enrolled Hub: %@", $0.hubURL.absoluteString) } ?? L("Not enrolled")
            deliveryEnabled = preferences.isEnabled && credential != nil
            canEnableDelivery = credential != nil && senderAvailable
            if let queueStatus = await sender?.currentQueueStatus() {
                render(state: senderState, queueStatus: queueStatus)
            }
            await sender?.setEnabled(preferences.isEnabled && credential != nil && senderAvailable)
        }
    }

    private func startConnectivityMonitor() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor in
                guard let sender = self?.sender else { return }
                await sender.setConnectivityAvailable(path.status == .satisfied)
            }
        }
        networkMonitor.start(queue: networkQueue)
    }

    private func render(state: AgentIngestSenderState, queueStatus: AgentDeliveryQueueStatus) {
        senderState = state
        status = label(for: state)
        pending = L(
            "Pending: %lld · invalid: %lld · overflow: %lld · prior unclassified: %lld",
            queueStatus.pendingCount,
            queueStatus.contractRejectedCount,
            queueStatus.queueOverflowCount,
            queueStatus.legacyUnclassifiedCount
        )
        oldestPending = L("Oldest pending: %@", format(queueStatus.oldestPendingAt, fallback: L("none")))
        lastAcknowledged = L("Last acknowledged: %@", format(queueStatus.lastAcknowledgedAt, fallback: L("never")))
    }

    private func label(for state: AgentIngestSenderState) -> String {
        switch state {
        case .off: return L("Delivery is off")
        case .paused: return L("Delivery is paused")
        case .waitingForNetwork: return L("Waiting for a network path to the configured Hub")
        case .idle: return L("Ready")
        case .sending: return L("Sending a bounded batch...")
        case .retryScheduled(let date): return L("Hub unavailable; next low-frequency retry %@", format(date, fallback: ""))
        case .authorizationRequired: return L("Hub authorization expired or was revoked")
        case .failed(let message): return message
        }
    }

    private func format(_ date: Date?, fallback: String) -> String {
        guard let date else { return fallback }
        return DateFormatter.localizedString(from: date, dateStyle: .short, timeStyle: .medium)
    }

    static func enrollmentMessage(for error: Error) -> String {
        switch error {
        case AgentEnrollmentError.declined:
            return L("The Hub administrator declined this device.")
        case AgentEnrollmentError.expired:
            return L("The request expired before it was approved. Ask for a new code and try again.")
        case AgentEnrollmentError.plaintextNotAccepted:
            return L("The Hub refuses unencrypted connections. Enable HTTPS on the Hub, or accept unencrypted agent traffic in its settings.")
        case AgentEnrollmentError.invalidEnrollmentCode:
            return L("That code is not in the expected format. It is six characters, letters and digits.")
        case AgentEnrollmentError.invalidHubURL:
            return L("Enter an https:// address, or http:// only when the Hub runs on this Mac.")
        default:
            return L("Could not reach the Hub. Check the address and try again.")
        }
    }
}

enum AgentMonitoringMode: String, CaseIterable, Identifiable {
    case full
    case lightweight
    case paused

    var id: String { rawValue }
    var title: String {
        switch self {
        case .full: return L("Network")
        case .lightweight: return L("Lightweight")
        case .paused: return L("Paused")
        }
    }
}

@MainActor
private final class AgentSettingsViewModel: ObservableObject {
    @Published var monitoringMode = AgentMonitoringMode.paused
    @Published private(set) var monitoringStatus = L("Monitoring paused")
    @Published private(set) var launchAtLogin = false
    @Published private(set) var launchAtLoginDetail = ""
    @Published var retentionDays = ObservationWindowController.configuredRetentionDays
    @Published var message: String?
    /// Off unless the user turns it on: this is the one setting that would send
    /// the destinations the agent is watching to somebody else.
    @Published var thirdPartyGeoLookupEnabled = GeoCachePreferences().thirdPartyLookupEnabled {
        didSet { GeoCachePreferences().thirdPartyLookupEnabled = thirdPartyGeoLookupEnabled }
    }
    @Published var readsServerName = ServerNamePreferences().isEnabled {
        didSet { ServerNamePreferences().isEnabled = readsServerName }
    }
    let isLightweightMonitoringAvailable = false

    var availableMonitoringModes: [AgentMonitoringMode] {
        isLightweightMonitoringAvailable ? AgentMonitoringMode.allCases : [.full, .paused]
    }

    private let store: ObservationStore?
    private let launchController: LaunchAtLoginController
    private let onMonitoringMode: (AgentMonitoringMode) -> Void
    private let onRetentionChanged: (Int) -> Void
    private let onLanguageChanged: () -> Void
    private let maintenanceQueue = DispatchQueue(label: "com.egressview.agent.settings-maintenance")

    init(
        store: ObservationStore?,
        launchController: LaunchAtLoginController,
        onMonitoringMode: @escaping (AgentMonitoringMode) -> Void,
        onRetentionChanged: @escaping (Int) -> Void,
        onLanguageChanged: @escaping () -> Void
    ) {
        self.store = store
        self.launchController = launchController
        self.onMonitoringMode = onMonitoringMode
        self.onRetentionChanged = onRetentionChanged
        self.onLanguageChanged = onLanguageChanged
        refreshLaunchAtLogin()
    }

    func setMonitoringMode(_ mode: AgentMonitoringMode) {
        monitoringMode = mode
        onMonitoringMode(mode)
    }

    func updateMonitoringStatus(_ status: AgentMonitoringStatus) {
        monitoringStatus = status.label
        switch status {
        case .fullActive, .fullStarting, .fullActivationRequested, .approvalRequired,
             .rebootRequired, .updateNotRunning, .notRecording:
            monitoringMode = .full
        case .lightweight:
            monitoringMode = .lightweight
        case .paused:
            monitoringMode = .paused
        case .deactivating, .removalApprovalRequired, .removalRebootRequired, .failed:
            break
        }
    }

    func toggleLaunchAtLogin() {
        do {
            try launchController.toggle()
            message = nil
        } catch {
            message = L("Launch at login failed: %@", error.localizedDescription)
        }
        refreshLaunchAtLogin()
    }

    func setRetentionDays(_ days: Int) {
        guard ObservationRetention.allowedRetentionDays.contains(days) else { return }
        retentionDays = days
        ObservationWindowController.configuredRetentionDays = days
        onRetentionChanged(days)
    }

    func setLanguage(_ language: AgentLanguage) {
        AgentLanguageSettings.shared.language = language
        refreshLocalization()
        onLanguageChanged()
    }

    func refreshLocalization() {
        refreshLaunchAtLogin()
    }

    func removeAllHistory() {
        guard let store else {
            message = L("Local history is unavailable.")
            return
        }
        maintenanceQueue.async { [weak self] in
            let result = Result { try store.removeAll() }
            DispatchQueue.main.async {
                switch result {
                case .success(let count): self?.message = L("Deleted %lld local records.", count)
                case .failure(let error): self?.message = L("Could not delete local history: %@", error.localizedDescription)
                }
            }
        }
    }

    private func refreshLaunchAtLogin() {
        switch launchController.state {
        case .enabled:
            launchAtLogin = true
            launchAtLoginDetail = L("Starts automatically after you sign in.")
        case .disabled:
            launchAtLogin = false
            launchAtLoginDetail = L("The agent must be opened manually after sign-in.")
        case .requiresApproval:
            launchAtLogin = false
            launchAtLoginDetail = L("Approval is required in System Settings > Login Items.")
        case .unavailable:
            launchAtLogin = false
            launchAtLoginDetail = L("Launch at login is unavailable for this build.")
        }
    }
}

private enum AgentSettingsSection: String, CaseIterable, Identifiable {
    case general
    case hub
    case history
    case uninstall

    var id: String { rawValue }
    var title: String {
        switch self {
        case .general: return L("General")
        case .hub: return L("Hub")
        case .history: return L("History")
        case .uninstall: return L("Uninstall")
        }
    }
    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .hub: return "network"
        case .history: return "clock.arrow.circlepath"
        case .uninstall: return "trash"
        }
    }
}

private struct AgentSettingsView: View {
    @ObservedObject var model: AgentSettingsViewModel
    @ObservedObject var hub: HubDeliveryController
    @ObservedObject var updates: AgentUpdateController
    @ObservedObject var uninstall: AgentUninstallController
    @ObservedObject var geo: GeoCacheController
    @ObservedObject var threats: ThreatIntelController
    @ObservedObject private var language = AgentLanguageSettings.shared
    @State private var section = AgentSettingsSection.general
    @State private var confirmHistoryDeletion = false
    @State private var confirmUninstall = false
    @State private var confirmLocalOnlyUninstall = false

    var body: some View {
        NavigationSplitView {
            List(AgentSettingsSection.allCases, selection: $section) { item in
                Label(item.title, systemImage: item.symbol).tag(item)
            }
            .navigationSplitViewColumnWidth(min: 150, ideal: 170, max: 200)
        } detail: {
            ScrollView {
                Group {
                    switch section {
                    case .general: general
                    case .hub: hubSettings
                    case .history: history
                    case .uninstall: uninstallSettings
                    }
                }
                .padding(28)
                .frame(maxWidth: 620, alignment: .leading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .frame(minWidth: 760, minHeight: 540)
        .alert("EgressView Agent", isPresented: messagePresented) {
            Button(L("OK"), role: .cancel) {
                model.message = nil
                hub.errorMessage = nil
            }
        } message: {
            Text(model.message ?? hub.errorMessage ?? "")
        }
    }

    private var general: some View {
        VStack(alignment: .leading, spacing: 24) {
            settingsTitle(L("General"), subtitle: L("Collection and startup behavior for this Mac."))
            settingsGroup(L("Monitoring")) {
                Picker(L("Mode"), selection: monitoringBinding) {
                    ForEach(model.availableMonitoringModes) { mode in Text(mode.title).tag(mode) }
                }
                .id(language.language.rawValue)
                .pickerStyle(.segmented)
                .disabled(uninstall.isRunning || uninstall.isReadyToRemoveApplication)
                Text(model.monitoringStatus).font(.callout).foregroundStyle(.secondary)
            }
            settingsGroup(L("Startup")) {
                Toggle(L("Launch EgressView Agent at login"), isOn: launchBinding)
                Text(model.launchAtLoginDetail).font(.callout).foregroundStyle(.secondary)
            }
            settingsGroup(L("Language")) {
                Picker(L("Display language"), selection: languageBinding) {
                    ForEach(AgentLanguage.allCases) { option in Text(option.title).tag(option) }
                }
                .frame(width: 240)
            }
            settingsGroup(L("Updates")) {
                Toggle(L("Check automatically once per day"), isOn: updateCheckBinding)
                Text(L("Update checks send only the Agent version and macOS version. They do not send a device or installation identifier."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Text(updates.status).font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button(updates.isChecking ? L("Checking...") : L("Check now")) {
                        updates.checkNow()
                    }
                    .disabled(updates.isChecking)
                    if updates.availableVersion != nil {
                        Button(L("Open installer")) {
                            updates.openInstaller()
                        }
                        .disabled(updates.isOpeningInstaller)
                    }
                }
                if updates.availableVersion != nil {
                    Text(L("Installing temporarily stops monitoring and macOS may ask you to approve the System Extension again."))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var hubSettings: some View {
        VStack(alignment: .leading, spacing: 22) {
            settingsTitle(L("Hub delivery"), subtitle: L("This Mac pushes only to the Hub you choose. The Hub never polls this Mac."))
            settingsGroup(L("Enrollment")) {
                TextField("https://hub.example", text: $hub.hubAddress)
                    .textFieldStyle(.roundedBorder)
                SecureField(L("Six-character enrollment code"), text: $hub.enrollmentCode)
                    .textFieldStyle(.roundedBorder)
                Text(L("Sent metadata summary"))
                    .font(.callout).foregroundStyle(.secondary)
                Text(L("Not sent metadata summary"))
                    .font(.callout).foregroundStyle(.secondary)
                Toggle(L("Confirm metadata delivery"), isOn: $hub.consentConfirmed)
                Button(hub.isEnrolling ? L("Waiting for Hub approval...") : L("Request access")) {
                    hub.requestAccess()
                }
                .disabled(hub.isEnrolling)
            }
            .disabled(uninstall.isRunning || uninstall.isReadyToRemoveApplication)
            settingsGroup(L("Delivery")) {
                Text(hub.enrolledHub).font(.headline)
                Toggle(L("Send observations to the enrolled Hub"), isOn: deliveryBinding)
                    .disabled(!hub.canEnableDelivery && !hub.deliveryEnabled)
                Text(hub.status).foregroundStyle(.secondary)
                Text(hub.pending).font(.callout)
                Text(hub.oldestPending).font(.callout).foregroundStyle(.secondary)
                Text(hub.lastAcknowledged).font(.callout).foregroundStyle(.secondary)
                Button(L("Send now")) { hub.sendNow() }.disabled(!hub.deliveryEnabled)
            }
            .disabled(uninstall.isRunning || uninstall.isReadyToRemoveApplication)
            Divider().padding(.vertical, 4)
            geoSection
            serverNameSection
            threatSection
        }
    }

    /// Locations come from the Hub, so they live beside it. The button exists
    /// because someone who has just enrolled, or who is looking at an empty
    /// map, should not have to wait for a timer to find out why.
    @ViewBuilder
    private var geoSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Destination locations")).font(.headline)
            Text(L("Used to place traffic on the map. Fetched from the Hub once a day; the request contains no destinations."))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button(L("Fetch now")) {
                    Task { await geo.refresh() }
                }
                .disabled(geo.status == .fetching)
                Text(geoStatusText).font(.caption).foregroundStyle(.secondary)
            }
            Toggle(isOn: $model.thirdPartyGeoLookupEnabled) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Look up locations without a Hub"))
                    // Said plainly: this is the one place the agent would send
                    // the very destinations it is watching to someone else.
                    Text(L("Sends destination IP addresses to ip-api.com. Off unless you turn it on."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var serverNameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Destination names")).font(.headline)
            Text(L("macOS supplies the name for applications that use its own networking. About half of connections come from applications that do not, including every browser measured — those show as addresses."))
                .font(.caption)
                .foregroundStyle(.secondary)
            Toggle(isOn: $model.readsServerName) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Read the name from the TLS handshake"))
                    // Said plainly, because the honest objection to this setting
                    // is "you told me you never look inside connections".
                    Text(L("Reads the first message of a connection, in which the client says where it is going before anything is encrypted. Nothing is decrypted, nothing after that message is read, and the name stays on this Mac. Off unless you turn it on. Applies to connections started after the change."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var threatSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Threat information")).font(.headline)
            Text(L("Destinations are checked against threat feeds on this Mac. The check itself never leaves the machine, whichever source the feeds came from."))
                .font(.caption)
                .foregroundStyle(.secondary)
            HStack(spacing: 10) {
                Button(L("Fetch now")) {
                    Task { await threats.refresh() }
                }
                .disabled(threats.status == .fetching)
                Text(threatStatusText).font(.caption).foregroundStyle(.secondary)
            }
            if threats.isDirectDownloadAvailable {
                // Offered only without a Hub. With one, the indicators already
                // arrive from it, and downloading them again would contact
                // third parties for something already in hand.
                Toggle(isOn: Binding(
                    get: { threats.isDirectDownloadEnabled },
                    set: { threats.isDirectDownloadEnabled = $0 }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("Download threat feeds without a Hub"))
                        Text(L("Downloads public block lists from abuse.ch and spamhaus.org. No destination from this Mac is sent to them; they only learn that this Mac asked. Off unless you turn it on."))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        // Downloaded by this Mac, under its own terms, not
                        // relayed by us. Whoever switches it on is the one
                        // agreeing, so they get the links.
                        HStack(spacing: 6) {
                            Link(L("abuse.ch terms"), destination: URL(string: "https://abuse.ch/terms-of-service/")!)
                            Text("·").foregroundStyle(.secondary)
                            Link(L("Spamhaus terms"), destination: URL(string: "https://www.spamhaus.org/legal/")!)
                        }
                        .font(.caption)
                    }
                }
            } else {
                Text(L("Threat information comes from your Hub. This Mac sends no destinations to anyone."))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var threatStatusText: String {
        switch threats.status {
        case .idle: return ""
        case .fetching: return L("Fetching...")
        case let .updated(count, _): return L("%lld indicators", count)
        case let .partial(count, missing, _):
            // The count on its own would read as success. Which lists are
            // missing is the part that lets someone judge what the check is
            // worth right now.
            return L(
                "%lld indicators, but %@ could not be read. Destinations are checked against the rest.",
                count,
                missing.joined(separator: ", ")
            )
        case .unchanged: return L("Already up to date")
        case .hubHasNoFeeds: return L("The Hub is not running threat feeds")
        case .notEnabled: return L("Not switched on")
        case let .failed(message): return message
        }
    }

    private var geoStatusText: String {
        switch geo.status {
        case .idle: return ""
        case .fetching: return L("Fetching...")
        case let .updated(count, _): return L("%lld locations", count)
        case .unchanged: return L("Already up to date")
        case .unavailableWithoutHub: return L("Not enrolled with a Hub")
        case let .failed(message): return message
        }
    }


    private var history: some View {
        VStack(alignment: .leading, spacing: 24) {
            settingsTitle(L("Local history"), subtitle: L("Choose how long this Mac keeps connection metadata."))
            settingsGroup(L("Retention")) {
                Picker(L("Keep history"), selection: retentionBinding) {
                    ForEach(ObservationRetention.allowedRetentionDays, id: \.self) { days in
                        Text(days == 1 ? L("1 day") : L("%lld days", days)).tag(days)
                    }
                }
                .frame(width: 220)
                Text(L("Recent individual records are kept for up to 14 days. Older data is reduced to hourly totals until the selected retention expires."))
                    .font(.callout).foregroundStyle(.secondary)
            }
            settingsGroup(L("Delete")) {
                Text(L("This permanently deletes local history. It does not delete observations already accepted by a Hub."))
                    .font(.callout).foregroundStyle(.secondary)
                Button(L("Delete all local history"), role: .destructive) {
                    confirmHistoryDeletion = true
                }
                .confirmationDialog(L("Delete all local history?"), isPresented: $confirmHistoryDeletion) {
                    Button(L("Delete history"), role: .destructive) { model.removeAllHistory() }
                    Button(L("Cancel"), role: .cancel) {}
                }
            }
        }
    }

    private var uninstallSettings: some View {
        VStack(alignment: .leading, spacing: 24) {
            settingsTitle(
                L("Uninstall EgressView Agent"),
                subtitle: L("Stop monitoring cleanly before moving the app to Trash.")
            )
            settingsGroup(L("What will be removed")) {
                Label(L("System Extension and network filter configuration"), systemImage: "network.slash")
                Label(L("Login item"), systemImage: "person.crop.circle.badge.minus")
                Label(L("Hub credential and pending delivery queue"), systemImage: "key.slash")
                Label(L("This Mac's registration at the enrolled Hub"), systemImage: "server.rack")
                Toggle(L("Also delete local connection history"), isOn: $uninstall.removeHistory)
                Text(L("History is kept by default. Data already accepted by a Hub is never deleted from the Hub by this operation."))
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            settingsGroup(L("Remove")) {
                Text(uninstall.status)
                    .font(.callout)
                    .foregroundStyle(uninstall.needsManualHubRevocation ? .orange : .secondary)
                if uninstall.needsManualHubRevocation {
                    Text(L("Continuing locally leaves the Hub registration active. Revoke this Mac manually in the Hub's Agent settings."))
                        .font(.callout)
                        .foregroundStyle(.orange)
                    HStack {
                        Button(L("Retry Hub revocation")) { uninstall.begin() }
                        Button(L("Continue locally"), role: .destructive) {
                            confirmLocalOnlyUninstall = true
                        }
                    }
                    .confirmationDialog(
                        L("Continue without revoking the Hub registration?"),
                        isPresented: $confirmLocalOnlyUninstall
                    ) {
                        Button(L("Continue and revoke manually"), role: .destructive) {
                            uninstall.continueWithoutHub()
                        }
                        Button(L("Cancel"), role: .cancel) {}
                    }
                } else if uninstall.isReadyToRemoveApplication {
                    Button(L("Show EgressView Agent in Finder")) { uninstall.revealApplication() }
                } else {
                    Button(L("Prepare to uninstall..."), role: .destructive) {
                        confirmUninstall = true
                    }
                    .disabled(uninstall.isRunning)
                    .confirmationDialog(
                        L("Prepare EgressView Agent for removal?"),
                        isPresented: $confirmUninstall
                    ) {
                        Button(L("Stop monitoring and continue"), role: .destructive) {
                            uninstall.begin()
                        }
                        Button(L("Cancel"), role: .cancel) {}
                    }
                }
                if uninstall.isReadyToRemoveApplication {
                    Text(L("Quit EgressView Agent, then move it to Trash in Finder."))
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var monitoringBinding: Binding<AgentMonitoringMode> {
        Binding(get: { model.monitoringMode }, set: { model.setMonitoringMode($0) })
    }

    private var launchBinding: Binding<Bool> {
        Binding(get: { model.launchAtLogin }, set: { _ in model.toggleLaunchAtLogin() })
    }

    private var retentionBinding: Binding<Int> {
        Binding(get: { model.retentionDays }, set: { model.setRetentionDays($0) })
    }

    private var languageBinding: Binding<AgentLanguage> {
        Binding(get: { language.language }, set: { model.setLanguage($0) })
    }

    private var updateCheckBinding: Binding<Bool> {
        Binding(get: { updates.isEnabled }, set: { updates.setEnabled($0) })
    }

    private var deliveryBinding: Binding<Bool> {
        Binding(get: { hub.deliveryEnabled }, set: { hub.setDeliveryEnabled($0) })
    }

    private var messagePresented: Binding<Bool> {
        Binding(
            get: { model.message != nil || hub.errorMessage != nil },
            set: { if !$0 { model.message = nil; hub.errorMessage = nil } }
        )
    }

    private func settingsTitle(_ title: String, subtitle: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.largeTitle.bold())
            Text(subtitle).foregroundStyle(.secondary)
        }
    }

    private func settingsGroup<Content: View>(_ title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).font(.headline)
            content()
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 12))
    }
}

@MainActor
final class SettingsWindowController: NSWindowController, NSWindowDelegate {
    private let model: AgentSettingsViewModel
    private let hub: HubDeliveryController
    private let updates: AgentUpdateController
    private let uninstall: AgentUninstallController
    private let geo: GeoCacheController
    private let threats: ThreatIntelController
    private let onClose: () -> Void

    init(
        store: ObservationStore?,
        hub: HubDeliveryController,
        updates: AgentUpdateController,
        uninstall: AgentUninstallController,
        geo: GeoCacheController,
        threats: ThreatIntelController,
        launchController: LaunchAtLoginController,
        onMonitoringMode: @escaping (AgentMonitoringMode) -> Void,
        onRetentionChanged: @escaping (Int) -> Void,
        onLanguageChanged: @escaping () -> Void,
        onClose: @escaping () -> Void = {}
    ) {
        self.hub = hub
        self.updates = updates
        self.uninstall = uninstall
        self.geo = geo
        self.threats = threats
        self.onClose = onClose
        let model = AgentSettingsViewModel(
            store: store,
            launchController: launchController,
            onMonitoringMode: onMonitoringMode,
            onRetentionChanged: onRetentionChanged,
            onLanguageChanged: onLanguageChanged
        )
        self.model = model
        let hostingController = NSHostingController(
            rootView: AgentSettingsView(model: model, hub: hub, updates: updates, uninstall: uninstall, geo: geo, threats: threats)
        )
        let window = NSWindow(contentViewController: hostingController)
        window.title = L("EgressView Agent Settings")
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 820, height: 600))
        window.minSize = NSSize(width: 760, height: 540)
        super.init(window: window)
        window.delegate = self
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func show() {
        hub.refresh()
        showWindow(nil)
        window?.center()
        window?.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    func updateMonitoringStatus(_ status: AgentMonitoringStatus) {
        model.updateMonitoringStatus(status)
    }

    func refreshLocalization() {
        window?.title = L("EgressView Agent Settings")
        model.refreshLocalization()
        hub.refresh()
        updates.refreshLocalization()
        uninstall.refreshLocalization()
    }

    func windowWillClose(_ notification: Notification) {
        onClose()
    }
}

// MARK: - Destination locations

/// Keeps the local location table fed from the Hub the agent is enrolled with.
///
/// Runs on launch and once a day. There is no "wait until tomorrow" on a fresh
/// install: an agent with no locations has an empty map, and making the user
/// wait a day for their first one would be a strange way to introduce it.
@MainActor
final class GeoCacheController: ObservableObject {
    enum Status: Equatable {
        case idle
        case fetching
        case updated(count: Int, at: Date)
        case unchanged(at: Date)
        case unavailableWithoutHub
        case failed(String)
    }

    @Published private(set) var status: Status = .idle

    private let store: ObservationStore?
    private let credentialStore: any AgentCredentialStoring
    private let preferences = GeoCachePreferences()
    private let agentVersion: String
    private let timer = PeriodicWork()

    init(store: ObservationStore?, credentialStore: any AgentCredentialStoring, agentVersion: String) {
        self.store = store
        self.credentialStore = credentialStore
        self.agentVersion = agentVersion
    }

    func start() {
        Task { await self.refreshIfDue() }
        timer.start(every: 3_600) { [weak self] in
            Task { @MainActor in await self?.refreshIfDue() }
        }
    }

    func stop() {
        timer.stop()
    }

    private func refreshIfDue() async {
        let credential = await credentialStore.loadDetached()
        guard preferences.shouldFetch(now: Date(), hasHub: credential != nil) else { return }
        await refresh()
    }

    /// The settings screen calls this directly. Someone who has just enrolled,
    /// or who wants to know why the map is empty, should not have to wait for a
    /// timer to find out.
    func refresh() async {
        guard let store else { return }
        guard let credential = await credentialStore.loadDetached() else {
            status = .unavailableWithoutHub
            return
        }
        status = .fetching
        let fetcher = GeoCacheFetcher(
            hubURL: credential.hubURL,
            token: credential.token,
            userAgent: "EgressViewAgent/\(agentVersion)",
            transport: URLSessionGeoCacheTransport()
        )
        do {
            switch try await fetcher.fetch(knownETag: preferences.etag) {
            case .unchanged:
                preferences.lastFetchedAt = Date()
                status = .unchanged(at: Date())
            case let .updated(entries, etag):
                try store.replaceGeoLocations(entries)
                preferences.etag = etag
                preferences.lastFetchedAt = Date()
                status = .updated(count: entries.count, at: Date())
            }
        } catch {
            // The stored tag is kept: a failed fetch is not evidence that what
            // we already hold is wrong.
            status = .failed(Self.describe(error))
        }
    }

    /// Phrased for someone deciding what to do about it.
    static func describe(_ error: any Error) -> String {
        switch error {
        case GeoCacheFetchError.insecureURL:
            return L("The Hub address is not HTTPS, so locations were not requested.")
        case let GeoCacheFetchError.httpStatus(code) where code == 401 || code == 403:
            return L("The Hub refused the request. Re-enrol this Mac to fetch locations.")
        case let GeoCacheFetchError.httpStatus(code):
            return L("The Hub returned HTTP %lld.", code)
        case let GeoCacheFetchError.unsupportedSchemaVersion(version):
            return L("This Hub sends location data this agent does not understand (version %lld).", version)
        case let GeoCacheFetchError.transport(reason):
            return L("Could not reach the Hub: %@", reason)
        default:
            return String(describing: error)
        }
    }
}
