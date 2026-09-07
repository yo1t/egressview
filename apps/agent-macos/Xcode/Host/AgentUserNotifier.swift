import Combine
import EgressViewAgentCore
import Foundation
import os
@preconcurrency import UserNotifications

/// Keeps every notification explicit about the event that caused it.
/// An action alone (for example, "open Settings") does not tell the user why
/// the Agent interrupted them, especially when it is read later in History.
func notificationExplanation(reason: String, action: String? = nil) -> String {
    guard let action, !action.isEmpty else { return L("Why: %@", reason) }
    return L("Why: %@\n%@", reason, action)
}

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
            guard limiter.consume(
                key: key, cooldown: cooldown, dailyLimit: dailyLimit,
                countsTowardDailyLimit: kind != .monitoring
            ) else {
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
            body: notificationExplanation(
                reason: L("You selected Send test notification."),
                action: L("Notifications are configured for this Mac.")
            ),
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
    private let hubRetryTimer = PeriodicWork()
    /// Says whether an outage was announced or refused, and whether the retry
    /// is running.
    ///
    /// Without it, "no notification arrived" has two causes that look
    /// identical from outside: the problem was never detected, or it was
    /// detected and the limiter refused it. That ambiguity cost a full
    /// eighty-eight minute measurement on 2026-09-07 (P3-88), and a second one
    /// to resolve. `.notice` and `privacy: .public` because `.info` is not
    /// written to the log store and interpolation is redacted by default --
    /// both learned the same day. None of this carries a destination.
    private let logger = Logger(subsystem: "com.egressview.agent.macos", category: "hub-notify")
    private let scanQueue = DispatchQueue(label: "com.egressview.agent.threat-notifications")
    private var cancellables: Set<AnyCancellable> = []
    private var lastThreatScanAt = Date()
    private var monitoringNeedsAttention = false
    /// Which Hub problem is outstanding and whether the user has heard about
    /// it. `removeDuplicates()` tells this object about a problem once; if the
    /// cooldown refuses that one attempt, nothing else would ever try (P3-88).
    private var hubProblems = AgentHubProblemTracker()
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
        // A problem that persists does not change the published state, so the
        // subscription above fires once and never again. This is what gives an
        // outage a second chance after its cooldown expires.
        hubRetryTimer.start(every: 60) { [weak self] in self?.retryHubAnnouncement() }
    }

    func stop() {
        scanTimer.stop()
        hubRetryTimer.stop()
        cancellables.removeAll()
    }

    func handleMonitoringStatus(_ status: AgentMonitoringStatus) {
        let issue: (String, String)?
        switch status {
        case .approvalRequired:
            issue = (
                L("Network monitoring needs approval"),
                notificationExplanation(
                    reason: L("Network monitoring has not started because macOS approval is still pending."),
                    action: L("Open EgressView Agent and approve network monitoring in System Settings.")
                )
            )
        case .rebootRequired:
            issue = (
                L("Restart required for monitoring"),
                notificationExplanation(
                    reason: L("macOS requires a restart before the approved network extension can monitor connections."),
                    action: L("Restart this Mac to finish enabling network monitoring.")
                )
            )
        case .updateNotRunning, .notRecording, .diagnosticNotRecording:
            return
        case .failed:
            issue = (
                L("Network monitoring needs attention"),
                notificationExplanation(
                    reason: L("Network monitoring entered a failed state and may not be recording connections."),
                    action: L("Open EgressView Agent to review the monitoring error.")
                )
            )
        case .fullActive, .lightweight:
            if monitoringNeedsAttention {
                monitoringNeedsAttention = false
                _ = notifier.notify(
                    kind: .recovery, key: "monitoring-recovered",
                    title: L("Network monitoring recovered"),
                    body: notificationExplanation(
                        reason: L("Network monitoring previously needed attention and is now active again."),
                        action: L("EgressView Agent is recording connections again.")
                    )
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

    /// The wording for a delivery problem, or nil when the state is not one.
    ///
    /// Separate from `handleHubState` so the retry can rebuild it from the
    /// state as it stands now, rather than replaying a sentence written when
    /// the problem started (P3-88).
    private func issue(
        for state: HubDeliveryController.NotificationState
    ) -> (String, String, String)? {
        switch state {
        case .unavailable:
            return (
                "unavailable", L("Hub delivery is delayed"),
                notificationExplanation(
                    reason: L("Delivery to the configured Hub failed and a retry was scheduled."),
                    action: L("Observations remain on this Mac and will be retried at low frequency.")
                )
            )
        case .authorizationRequired:
            return (
                "authorization", L("Hub authorization is required"),
                notificationExplanation(
                    reason: L("The Hub authorization expired or was revoked, so queued observations cannot be sent."),
                    action: L("Open EgressView Agent and enroll this Mac with the Hub again.")
                )
            )
        case .dataDropped:
            return (
                "dropped", L("Some Hub observations were not queued"),
                notificationExplanation(
                    reason: L("The queue overflow or contract-rejection counter increased, so some observations were not retained for Hub delivery."),
                    action: L("Open EgressView Agent to review the Hub delivery counters.")
                )
            )
        case .failed:
            return (
                "failed", L("Hub delivery needs attention"),
                notificationExplanation(
                    reason: L("The Hub sender entered a failed state and queued observations are not being delivered."),
                    action: L("Open EgressView Agent to review the delivery error.")
                )
            )
        case .healthy, .inactive:
            return nil
        }
    }

    private func handleHubState(_ state: HubDeliveryController.NotificationState) {
        let issue = issue(for: state)
        switch state {
        case .healthy:
            // Only for a problem the user heard about. Otherwise "delivery
            // recovered" arrives for something they were never told had
            // broken -- which is how the eighty-eight minute outage read.
            if hubProblems.recovered() {
                _ = notifier.notify(
                    kind: .recovery, key: "hub-recovered",
                    title: L("Hub delivery recovered"),
                    body: notificationExplanation(
                        reason: L("Hub delivery previously needed attention and is now healthy again."),
                        action: L("Queued observations can be delivered again.")
                    )
                )
            }
            return
        case .inactive:
            hubProblems.inactive()
            return
        case .unavailable, .authorizationRequired, .dataDropped, .failed:
            break
        }
        guard let issue else { return }
        guard hubProblems.problem(cause: issue.0) else { return }
        announceHubProblem(issue)
    }

    /// Sends one attempt and records whether it reached the user.
    ///
    /// The limiter's answer is the whole point: a notification it refused did
    /// not tell anyone anything, so the problem stays outstanding and the timer
    /// tries again once the cooldown allows it.
    private func announceHubProblem(_ issue: (String, String, String)) {
        let delivered = notifier.notify(
            kind: .hubDelivery, key: "hub-\(issue.0)", title: issue.1, body: issue.2
        )
        logger.notice(
            "hub-notify: cause=\(issue.0, privacy: .public) delivered=\(delivered, privacy: .public)"
        )
        hubProblems.attempted(delivered: delivered)
    }

    private func retryHubAnnouncement() {
        let outstanding = hubProblems.shouldRetryAnnouncement()
        guard outstanding.retry, let cause = outstanding.cause else { return }
        logger.notice("hub-notify: retrying cause=\(cause, privacy: .public)")
        // Rebuild the wording from the state the controller holds now, rather
        // than replaying a stale sentence: an outage that has since become an
        // authorisation failure should say so.
        guard let issue = issue(for: hub.notificationState), issue.0 == cause else { return }
        announceHubProblem(issue)
    }

    private func handleThreatIntelStatus(_ status: ThreatIntelController.Status) {
        let message: String?
        switch status {
        case .updated:
            message = notificationExplanation(reason: L("The locally held threat information was updated."))
        case .partial:
            message = notificationExplanation(reason: L("Threat information changed, but one or more sources could not be read."))
        case .hubHasNoFeeds:
            message = notificationExplanation(reason: L("The connected Hub stopped providing threat information."))
        case .failed:
            message = notificationExplanation(reason: L("The latest threat-information update failed."))
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
        // High confidence only (P3-19).
        //
        // URLhaus lists where malware was served from, so a match on
        // github.com or s3.amazonaws.com says a file sat there -- not that the
        // destination is hostile. Notifying on those means telling someone
        // their normal use of Google Drive is a threat, every day, until they
        // stop reading the notifications. The low-confidence matches are still
        // recorded and still shown in the Threats tab; they just do not
        // interrupt anyone.
        let notifiable = report.highConfidenceAddresses
        let addresses = Set(report.findings.compactMap { finding -> String? in
            guard finding.candidate.lastObservedAt >= since,
                  notifiable.contains(finding.candidate.address),
                  seenThreats[finding.candidate.address] == nil else { return nil }
            return finding.candidate.address
        })
        guard !addresses.isEmpty else { return }
        let accepted = notifier.notify(
            kind: .threat, key: "threat-scan-\(Int(now.timeIntervalSince1970 / 60))",
            title: L("New threat match detected"),
            body: notificationExplanation(
                reason: L("The latest scan found %lld previously unnotified destinations that matched threat information.", addresses.count),
                action: L("Open the Threats tab to review them. Addresses and host names stay inside EgressView.")
            ),
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
        case .diagnosticNotRecording: return "diagnostic-not-recording"
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
