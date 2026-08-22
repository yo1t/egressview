import Combine
import EgressViewAgentCore
import Foundation
@preconcurrency import UserNotifications

struct AgentNotificationHistoryEntry: Codable, Identifiable, Equatable {
    let id: UUID
    let date: Date
    let kind: AgentNotificationKind
    let title: String
    let body: String
    let delivered: Bool
}

@MainActor
final class AgentUserNotifier: ObservableObject {
    enum PermissionState { case unknown, allowed, denied }
    static let shared = AgentUserNotifier()

    @Published var threatDetectionsEnabled: Bool { didSet { save(threatDetectionsEnabled, Keys.threat) } }
    @Published var monitoringEnabled: Bool { didSet { save(monitoringEnabled, Keys.monitoring) } }
    @Published var hubDeliveryEnabled: Bool { didSet { save(hubDeliveryEnabled, Keys.hub) } }
    @Published var threatIntelChangesEnabled: Bool { didSet { save(threatIntelChangesEnabled, Keys.intel) } }
    @Published var recoveryEnabled: Bool { didSet { save(recoveryEnabled, Keys.recovery) } }
    @Published var dailyLimit: AgentNotificationDailyLimit {
        didSet { defaults.set(dailyLimit.rawValue, forKey: Keys.dailyLimit) }
    }
    @Published private(set) var history: [AgentNotificationHistoryEntry]
    @Published private(set) var permissionState: PermissionState = .unknown
    @Published private(set) var sentToday = 0
    @Published private(set) var suppressedToday = 0

    private enum Keys {
        static let threat = "agentNotifications.threat"
        static let monitoring = "agentNotifications.monitoring"
        static let hub = "agentNotifications.hub"
        static let intel = "agentNotifications.intel"
        static let recovery = "agentNotifications.recovery"
        static let dailyLimit = "agentNotifications.dailyLimit"
        static let limiter = "agentNotifications.limiter"
        static let history = "agentNotifications.history"
    }

    private let defaults: UserDefaults
    private var limiter: AgentNotificationLimiter

    private init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        threatDetectionsEnabled = Self.bool(defaults, Keys.threat, true)
        monitoringEnabled = Self.bool(defaults, Keys.monitoring, true)
        hubDeliveryEnabled = Self.bool(defaults, Keys.hub, true)
        threatIntelChangesEnabled = Self.bool(defaults, Keys.intel, false)
        recoveryEnabled = Self.bool(defaults, Keys.recovery, false)
        dailyLimit = defaults.object(forKey: Keys.dailyLimit) == nil
            ? .defaultValue
            : (AgentNotificationDailyLimit(rawValue: defaults.integer(forKey: Keys.dailyLimit)) ?? .defaultValue)
        let decoder = JSONDecoder()
        let limiterState = defaults.data(forKey: Keys.limiter)
            .flatMap { try? decoder.decode(AgentNotificationLimiterState.self, from: $0) }
            ?? AgentNotificationLimiterState()
        limiter = AgentNotificationLimiter(state: limiterState)
        history = defaults.data(forKey: Keys.history)
            .flatMap { try? decoder.decode([AgentNotificationHistoryEntry].self, from: $0) } ?? []
        sentToday = limiterState.sentToday
        suppressedToday = limiterState.suppressedToday
        refreshAuthorizationStatus()
    }

    @discardableResult
    func notify(
        kind: AgentNotificationKind, key: String, title: String, body: String,
        cooldown: TimeInterval = AgentNotificationLimiter.defaultCooldown,
        bypassPreference: Bool = false,
        bypassLimits: Bool = false
    ) -> Bool {
        guard bypassPreference || isEnabled(kind) else { return false }
        if !bypassLimits {
            guard limiter.consume(key: key, cooldown: cooldown, dailyLimit: dailyLimit) else {
                publishLimiterState()
                return false
            }
            publishLimiterState()
        }
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                guard let self else { return }
                switch settings.authorizationStatus {
                case .authorized, .provisional:
                    self.permissionState = .allowed
                    let delivered = (try? await Self.post(
                        title: title, body: body, to: center
                    )) != nil
                    self.appendHistory(kind, title, body, delivered)
                case .denied:
                    self.permissionState = .denied
                    self.appendHistory(kind, title, body, false)
                case .notDetermined:
                    let granted = (try? await center.requestAuthorization(
                        options: [.alert, .sound]
                    )) ?? false
                    self.permissionState = granted ? .allowed : .denied
                    var delivered = false
                    if granted {
                        delivered = (try? await Self.post(
                            title: title, body: body, to: center
                        )) != nil
                    }
                    self.appendHistory(kind, title, body, delivered)
                @unknown default:
                    self.permissionState = .denied
                    self.appendHistory(kind, title, body, false)
                }
            }
        }
        return true
    }

    func notify(title: String, body: String, completion: ((Bool) -> Void)? = nil) {
        let accepted = notify(
            kind: .monitoring, key: "monitoring-stall", title: title, body: body
        )
        completion?(accepted)
    }

    func sendTest() {
        _ = notify(
            kind: .monitoring, key: "test-\(UUID().uuidString)",
            title: L("EgressView Agent test notification"),
            body: L("Notifications are configured for this Mac."),
            cooldown: 0, bypassPreference: true, bypassLimits: true
        )
    }

    func clearHistory() {
        history = []
        defaults.removeObject(forKey: Keys.history)
    }

    func refreshAuthorizationStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                guard let self else { return }
                switch settings.authorizationStatus {
                case .authorized, .provisional: self.permissionState = .allowed
                case .denied: self.permissionState = .denied
                case .notDetermined: self.permissionState = .unknown
                @unknown default: self.permissionState = .unknown
                }
            }
        }
    }

    private func isEnabled(_ kind: AgentNotificationKind) -> Bool {
        switch kind {
        case .threat: return threatDetectionsEnabled
        case .monitoring: return monitoringEnabled
        case .hubDelivery: return hubDeliveryEnabled
        case .threatIntelChange: return threatIntelChangesEnabled
        case .recovery: return recoveryEnabled
        }
    }

    private func save(_ value: Bool, _ key: String) { defaults.set(value, forKey: key) }

    private func publishLimiterState() {
        sentToday = limiter.state.sentToday
        suppressedToday = limiter.state.suppressedToday
        defaults.set(try? JSONEncoder().encode(limiter.state), forKey: Keys.limiter)
    }

    private func appendHistory(
        _ kind: AgentNotificationKind, _ title: String, _ body: String, _ delivered: Bool
    ) {
        history.insert(AgentNotificationHistoryEntry(
            id: UUID(), date: Date(), kind: kind, title: title, body: body,
            delivered: delivered
        ), at: 0)
        history = Array(history.prefix(100))
        defaults.set(try? JSONEncoder().encode(history), forKey: Keys.history)
    }

    private static func bool(_ defaults: UserDefaults, _ key: String, _ fallback: Bool) -> Bool {
        defaults.object(forKey: key) == nil ? fallback : defaults.bool(forKey: key)
    }

    private static func post(
        title: String, body: String, to center: UNUserNotificationCenter
    ) async throws {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        try await center.add(UNNotificationRequest(
            identifier: UUID().uuidString, content: content, trigger: nil
        ))
    }
}

/// Turns collector, Hub and threat-intelligence state into bounded user events.
@MainActor
final class AgentNotificationCoordinator {
    private let store: ObservationStore?
    private let hub: HubDeliveryController
    private let threats: ThreatIntelController
    private let notifier: AgentUserNotifier
    private let scanTimer = PeriodicWork()
    private let scanQueue = DispatchQueue(label: "com.egressview.agent.threat-notifications")
    private var cancellables: Set<AnyCancellable> = []
    private var lastThreatScanAt = Date()
    private var monitoringNeedsAttention = false
    private var hubNeedsAttention = false
    private var seenThreats: [String: Date] = [:]

    init(
        store: ObservationStore?, hub: HubDeliveryController,
        threats: ThreatIntelController, notifier: AgentUserNotifier
    ) {
        self.store = store
        self.hub = hub
        self.threats = threats
        self.notifier = notifier
    }

    func start() {
        hub.$notificationState.dropFirst().removeDuplicates().sink { [weak self] state in
            self?.handleHubState(state)
        }.store(in: &cancellables)
        threats.$status.dropFirst().removeDuplicates().sink { [weak self] status in
            self?.handleThreatIntelStatus(status)
        }.store(in: &cancellables)
        lastThreatScanAt = Date()
        scanTimer.start(every: 60) { [weak self] in self?.scanForNewThreats() }
    }

    func stop() {
        scanTimer.stop()
        cancellables.removeAll()
    }

    func handleMonitoringStatus(_ status: AgentMonitoringStatus) {
        let issue: (String, String)?
        switch status {
        case .approvalRequired:
            issue = (L("Network monitoring needs approval"), L("Open EgressView Agent and approve network monitoring in System Settings."))
        case .rebootRequired:
            issue = (L("Restart required for monitoring"), L("Restart this Mac to finish enabling network monitoring."))
        case .updateNotRunning, .notRecording:
            return
        case .failed:
            issue = (L("Network monitoring needs attention"), L("Open EgressView Agent to review the monitoring error."))
        case .fullActive, .lightweight:
            if monitoringNeedsAttention {
                monitoringNeedsAttention = false
                _ = notifier.notify(
                    kind: .recovery, key: "monitoring-recovered",
                    title: L("Network monitoring recovered"),
                    body: L("EgressView Agent is recording connections again.")
                )
            }
            return
        default:
            return
        }
        monitoringNeedsAttention = true
        if let issue {
            _ = notifier.notify(
                kind: .monitoring, key: "monitoring-\(status.notificationKey)",
                title: issue.0, body: issue.1
            )
        }
    }

    private func handleHubState(_ state: HubDeliveryController.NotificationState) {
        let issue: (String, String, String)?
        switch state {
        case .unavailable:
            issue = ("unavailable", L("Hub delivery is delayed"), L("Observations remain on this Mac and will be retried at low frequency."))
        case .authorizationRequired:
            issue = ("authorization", L("Hub authorization is required"), L("Open EgressView Agent and enroll this Mac with the Hub again."))
        case .dataDropped:
            issue = ("dropped", L("Some Hub observations were not queued"), L("Open EgressView Agent to review the Hub delivery counters."))
        case .failed:
            issue = ("failed", L("Hub delivery needs attention"), L("Open EgressView Agent to review the delivery error."))
        case .healthy:
            if hubNeedsAttention {
                hubNeedsAttention = false
                _ = notifier.notify(
                    kind: .recovery, key: "hub-recovered",
                    title: L("Hub delivery recovered"),
                    body: L("Queued observations can be delivered again.")
                )
            }
            return
        case .inactive:
            return
        }
        hubNeedsAttention = true
        if let issue {
            _ = notifier.notify(
                kind: .hubDelivery, key: "hub-\(issue.0)", title: issue.1, body: issue.2
            )
        }
    }

    private func handleThreatIntelStatus(_ status: ThreatIntelController.Status) {
        let message: String?
        switch status {
        case .updated: message = L("Threat information was updated.")
        case .partial: message = L("Threat information was updated, but one or more sources could not be read.")
        case .hubHasNoFeeds: message = L("The Hub is not providing threat information.")
        case .failed: message = L("Threat information could not be updated.")
        default: message = nil
        }
        guard let message else { return }
        _ = notifier.notify(
            kind: .threatIntelChange, key: "threat-intel-\(status.notificationKey)",
            title: L("Threat information changed"), body: message
        )
    }

    private func scanForNewThreats() {
        let to = Date()
        let from = lastThreatScanAt
        lastThreatScanAt = to
        guard hub.notificationState != .healthy,
              case .checked = threats.availability,
              let store else { return }
        let availability = threats.availability
        scanQueue.async { [weak self] in
            let report = Result {
                ThreatReport.evaluate(
                    candidates: try store.destinationsForThreatMatching(from: from, to: to),
                    matcher: ThreatMatcher(indicators: try store.threatIndicators()),
                    availability: availability
                )
            }
            DispatchQueue.main.async { self?.handleThreatReport(report, since: from, now: to) }
        }
    }

    private func handleThreatReport(
        _ result: Result<ThreatReport, Error>, since: Date, now: Date
    ) {
        guard case .success(let report) = result else { return }
        seenThreats = seenThreats.filter { now.timeIntervalSince($0.value) < 86_400 }
        let addresses = Set(report.findings.compactMap { finding -> String? in
            guard finding.candidate.lastObservedAt >= since,
                  seenThreats[finding.candidate.address] == nil else { return nil }
            return finding.candidate.address
        })
        guard !addresses.isEmpty else { return }
        let accepted = notifier.notify(
            kind: .threat, key: "threat-scan-\(Int(now.timeIntervalSince1970 / 60))",
            title: L("New threat match detected"),
            body: L("%lld new destinations matched threat information. Open the Threats tab to review them.", addresses.count),
            cooldown: 0
        )
        if accepted { for address in addresses { seenThreats[address] = now } }
    }
}

private extension AgentMonitoringStatus {
    var notificationKey: String {
        switch self {
        case .approvalRequired: return "approval"
        case .rebootRequired: return "reboot"
        case .updateNotRunning: return "update"
        case .notRecording: return "not-recording"
        case .failed: return "failed"
        default: return "state"
        }
    }
}

private extension ThreatIntelController.Status {
    var notificationKey: String {
        switch self {
        case .updated: return "updated"
        case .partial: return "partial"
        case .hubHasNoFeeds: return "no-feeds"
        case .failed: return "failed"
        default: return "state"
        }
    }
}
