import EgressViewAgentCore
import Darwin
import Foundation
import AppKit
import NetworkExtension
import SystemExtensions

enum AgentMonitoringStatus: Equatable {
    case paused
    case lightweight(observationCount: Int)
    case fullActivationRequested
    /// Started, but nothing has come through yet. Distinct from `fullActive`
    /// because "the extension answered" and "traffic is being recorded" are not
    /// the same thing, and an update can leave the first true while the second
    /// is false.
    case fullStarting
    case fullActive
    case approvalRequired
    case rebootRequired
    /// Installed, but macOS is not running this copy, so nothing is collected
    /// until the machine restarts.
    case updateNotRunning
    /// Monitoring says it is running, macOS agrees, and nothing is arriving.
    /// Nothing is being recorded and no update explains it.
    case notRecording(silentSince: Date?)
    case deactivating
    case removalApprovalRequired
    case removalRebootRequired
    case failed(String)

    var label: String {
        switch self {
        case .paused: return L("Monitoring paused")
        case .lightweight(let count): return L("Lightweight monitoring: %lld connections", count)
        case .fullActivationRequested: return L("Requesting network monitoring approval...")
        case .fullStarting: return L("Network monitoring started. Waiting for the first connection.")
        case .fullActive: return L("Network monitoring active")
        case .approvalRequired: return L("Approve the System Extension in System Settings")
        case .rebootRequired: return L("Restart macOS to finish enabling network monitoring")
        case .updateNotRunning:
            return L("Nothing is being recorded. The update needs a restart of macOS before monitoring resumes.")
        case .notRecording(let since):
            guard let since else {
                return L("Nothing is being recorded. Monitoring reports that it is running, but no connection has arrived. Quit and reopen EgressView Agent to restart it.")
            }
            let formatter = DateFormatter()
            formatter.dateStyle = .short
            formatter.timeStyle = .short
            return L(
                "Nothing has been recorded since %@. Monitoring reports that it is running. Quit and reopen EgressView Agent to restart it.",
                formatter.string(from: since)
            )
        case .deactivating: return L("Stopping monitoring...")
        case .removalApprovalRequired: return L("Approve removal of the System Extension in System Settings")
        case .removalRebootRequired: return L("Restart macOS to finish removing the System Extension")
        case .failed(let message): return L("Monitoring failed: %@", message)
        }
    }

    /// Asset catalog name of the template image for this state.
    ///
    /// Three images, not seven: the menu bar is glanced at, not read. What an
    /// operator has to notice at a glance is whether something needs them.
    var menuBarImageName: String {
        switch self {
        case .paused, .deactivating: return "MenuBarPaused"
        case .lightweight, .fullActive: return "MenuBar"
        case .fullActivationRequested, .fullStarting, .approvalRequired, .rebootRequired,
             .updateNotRunning, .notRecording, .removalApprovalRequired, .removalRebootRequired,
             .failed:
            return "MenuBarAttention"
        }
    }

    /// Whether the menu bar spells the state out instead of relying on the
    /// icon alone.
    ///
    /// Normally false, because the label costs 70-130pt of a bar every other
    /// app competes for. It is true for exactly the states where nothing is
    /// being recorded: an icon that is one of three shapes is easy to stop
    /// noticing, and this is the one state the user has to notice -- the
    /// alternative is believing there is a record of a period that has none.
    /// A wider menu bar for the duration of an outage is a fair price.
    var menuBarShowsLabel: Bool {
        switch self {
        case .updateNotRunning, .notRecording: return true
        default: return false
        }
    }

    var menuBarLabel: String {
        switch self {
        case .paused: return L("EgressView: Paused")
        case .lightweight: return L("EgressView: Light")
        case .fullActive: return L("EgressView: Monitoring")
        case .fullStarting: return L("EgressView: Starting")
        case .updateNotRunning, .notRecording: return L("EgressView: Not recording")
        case .fullActivationRequested, .approvalRequired, .removalApprovalRequired: return L("EgressView: Approval")
        case .rebootRequired, .removalRebootRequired: return L("EgressView: Restart")
        case .deactivating: return L("EgressView: Stopping")
        case .failed: return L("EgressView: Error")
        }
    }
}

final class AgentMonitoringController {
    static let systemExtensionIdentifier = "com.egressview.agent.filter"

    var isLightweightMonitoringAvailable: Bool {
        // Every Xcode Host configuration is sandboxed. The libproc collector
        // remains available only through the separate command-line spike.
        false
    }

    /// State the status gate needs. Held in its own object because the gate is
    /// built in `init`, before `self` exists.
    private final class MonitoringGateState {
        /// Why nothing is being recorded, when that is the case. Held as the
        /// status itself rather than a flag because there are now two reasons
        /// -- an update macOS has not switched to, and a monitor that stopped
        /// delivering with nothing to blame -- and they need different words.
        var stall: AgentMonitoringStatus?
        /// Collector/activation state hidden behind a health warning. Replayed
        /// when real observations prove collection has recovered.
        var underlyingStatus: AgentMonitoringStatus = .paused
        /// Silence only means failure while the user expects collection.
        var monitoringExpected = false
        /// Later of monitoring start and the most recent wake.
        var monitoringSince: Date?
        var hasReportedStall = false
        /// A coverage session is open in the store.
        var isCoverageOpen = false
    }

    private let statusHandler: (AgentMonitoringStatus) -> Void
    private let store: ObservationStore?
    private let observationHandler: ([ConnectionObservation]) -> Void
    private let storageErrorHandler: (Error) -> Void
    private let extensionController: SystemExtensionController
    private let gateState: MonitoringGateState
    private let healthProbe: SystemExtensionHealthProbe
    private let healthTimer = PeriodicWork()
    private var lightweightCollector: LightweightCollector?
    private var fullMonitoringCollector: FullMonitoringCollector?
    private var persistenceSampler = ObservationPersistenceSampler()

    /// How often the app re-asks macOS whether it is still recording. Cheap
    /// enough to run while idle, frequent enough that a stalled update is not
    /// discovered a day later.
    private static let healthCheckInterval: TimeInterval = 60

    init(
        store: ObservationStore?,
        statusHandler: @escaping (AgentMonitoringStatus) -> Void,
        observationHandler: @escaping ([ConnectionObservation]) -> Void,
        storageErrorHandler: @escaping (Error) -> Void
    ) {
        let gateState = MonitoringGateState()
        // While an update is stalled, nothing is being recorded, so the
        // collectors must not be able to paint over that with "active". The
        // stall is the more important truth and it stays on screen.
        let gatedStatusHandler: (AgentMonitoringStatus) -> Void = { status in
            var status = status
            switch status {
            case .fullStarting, .fullActive:
                if !gateState.monitoringExpected {
                    gateState.monitoringSince = Date()
                }
                gateState.monitoringExpected = true
                gateState.underlyingStatus = status
            case .updateNotRunning, .notRecording:
                // Health warnings overlay the collector's last real state.
                break
            case .fullActivationRequested:
                gateState.monitoringExpected = false
                gateState.monitoringSince = nil
                gateState.underlyingStatus = status
            default:
                gateState.monitoringExpected = false
                gateState.monitoringSince = nil
                gateState.stall = nil
                gateState.hasReportedStall = false
                gateState.underlyingStatus = status
            }
            if let stall = gateState.stall {
                switch status {
                case .fullActive, .fullStarting, .fullActivationRequested:
                    status = stall
                default:
                    break
                }
            }
            Self.recordCoverage(for: status, store: store, state: gateState)
            statusHandler(status)
        }

        self.store = store
        self.statusHandler = gatedStatusHandler
        self.observationHandler = observationHandler
        self.storageErrorHandler = storageErrorHandler
        self.gateState = gateState
        self.healthProbe = SystemExtensionHealthProbe(
            identifier: Self.systemExtensionIdentifier,
            appBundleVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
        )
        self.extensionController = SystemExtensionController(
            identifier: Self.systemExtensionIdentifier,
            statusHandler: gatedStatusHandler
        )
        if let store {
            self.fullMonitoringCollector = FullMonitoringCollector(
                store: store,
                observationHandler: observationHandler,
                statusHandler: gatedStatusHandler,
                errorHandler: storageErrorHandler,
                coverageHandler: { [weak gateState] in
                    guard let gateState, !gateState.isCoverageOpen else { return }
                    gateState.isCoverageOpen = true
                    try? store.beginCoverageSession(at: Date())
                },
                recoveryHandler: { [weak gateState] in
                    DispatchQueue.main.async {
                        // A rehearsal is not cleared by the data still
                        // arriving. Forcing the alarm only pretends the record
                        // is silent -- observations keep landing a second
                        // later, and without this they cancel the very state
                        // being rehearsed before it can be looked at. A real
                        // outage has no arriving data to cancel it.
                        guard !AgentDiagnostics.forcesNotRecording else { return }
                        guard let gateState, gateState.stall != nil else { return }
                        gateState.stall = nil
                        gateState.hasReportedStall = false
                        gateState.monitoringExpected = true
                        gateState.monitoringSince = Date()
                        gateState.underlyingStatus = .fullActive
                        statusHandler(.fullActive)
                    }
                }
            )
        }
    }

    /// Watches for the Mac going to sleep, so a hole in the record can be told
    /// apart from a fault.
    ///
    /// The two look identical in the data and mean opposite things: one is the
    /// machine not running, the other is this agent not working. Without this,
    /// an ordinary night reads as an outage -- and on 2026-08-15 an outage was
    /// investigated as if it were sleep, which is the same confusion running
    /// the other way.
    func startWatchingSleep() {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            forName: NSWorkspace.willSleepNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let store = self?.store else { return }
            try? store.beginSleepPeriod(at: Date())
        }
        center.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            guard let store = self?.store else { return }
            try? store.endSleepPeriod(at: Date())
            if self?.gateState.monitoringExpected == true {
                self?.gateState.monitoringSince = Date()
            }
            // Collection resumes on its own after a wake -- measured on
            // 2026-08-14, twice, with no gap beyond the sleep itself. The check
            // runs anyway because "it did last time" is not evidence about
            // this time.
            self?.checkHealth()
        }
    }

    /// Starts asking macOS whether monitoring is really running.
    ///
    /// Four consecutive updates stopped collection with nothing shown anywhere:
    /// the extension answered, the status said "Network monitoring active", and
    /// no data was recorded until the machine was restarted. Being told nothing
    /// is worse than the outage, because it leaves the user believing there is
    /// a record of a period that has none.
    func startHealthChecks() {
        checkHealth()
        // A dispatch source, not a run-loop `Timer`: see `PeriodicWork`.
        healthTimer.start(every: Self.healthCheckInterval) { [weak self] in
            self?.checkHealth()
        }
    }

    func stopHealthChecks() {
        healthTimer.stop()
    }

    /// Writes down when monitoring was really running, so the charts can say
    /// which parts of a period they know nothing about.
    ///
    /// Static because the gate that calls it is built before `self` exists.
    /// Opens a coverage session because data is arriving, whatever the status
    /// last said.
    ///
    /// Coverage used to open only on the collector's first `.fullActive`, so
    /// anything that closed a session closed it for good: the agent could go on
    /// collecting while the screen reported the period as unmonitored.
    ///
    /// Arriving data is the only evidence that actually bears on the question,
    /// so it is what opens the session.
    func noteObservationsRecorded() {
        guard let store, !gateState.isCoverageOpen else { return }
        gateState.isCoverageOpen = true
        try? store.beginCoverageSession(at: Date())
    }

    private static func recordCoverage(
        for status: AgentMonitoringStatus,
        store: ObservationStore?,
        state: MonitoringGateState
    ) {
        guard let store else { return }
        switch status {
        case .fullActive, .lightweight:
            guard !state.isCoverageOpen else { return }
            state.isCoverageOpen = true
            try? store.beginCoverageSession(at: Date())
        case .paused, .deactivating, .failed, .updateNotRunning, .notRecording, .rebootRequired,
             .approvalRequired, .removalApprovalRequired, .removalRebootRequired:
            guard state.isCoverageOpen else { return }
            state.isCoverageOpen = false
            try? store.endCoverageSession(at: Date())
        case .fullActivationRequested, .fullStarting:
            // Neither started nor stopped. Claiming coverage here would cover a
            // stretch where nothing was arriving.
            break
        }
    }

    /// Closes the current stretch of coverage when the app goes away.
    func endCoverageForShutdown() {
        guard let store, gateState.isCoverageOpen else { return }
        gateState.isCoverageOpen = false
        try? store.endCoverageSession(at: Date())
    }

    private func checkHealth() {
        guard gateState.monitoringExpected else { return }
        // A rehearsal answers the real question the real way: the times are
        // replaced, and everything downstream -- the verdict, the status, the
        // menu bar, the notification -- runs exactly as it would in an outage.
        // Short-circuiting straight to the notification would test the
        // notification and nothing else.
        let forced = AgentDiagnostics.forcesNotRecording
        let lastObservationAt = forced
            ? Date(timeIntervalSince1970: 0)
            : (try? store?.statistics().newestObservedAt) ?? nil
        healthProbe.check(
            lastObservationAt: lastObservationAt,
            awakeSince: forced ? Date(timeIntervalSince1970: 0) : gateState.monitoringSince
        ) { [weak self] health in
            guard let self else { return }
            // The user may pause while the asynchronous request is in flight.
            guard self.gateState.monitoringExpected else { return }
            // A properties request may take twenty seconds. Data arriving in
            // that window is newer and stronger evidence than its old snapshot.
            let latestObservationAt = forced
                ? lastObservationAt
                : ((try? self.store?.statistics().newestObservedAt) ?? nil)
            if !forced, let latestObservationAt,
               Date().timeIntervalSince(latestObservationAt)
                    < MonitoringHealthCheck.silenceThreshold {
                if self.gateState.stall != nil {
                    self.gateState.stall = nil
                    self.gateState.hasReportedStall = false
                    self.statusHandler(self.gateState.underlyingStatus)
                }
                return
            }
            switch health {
            case .rebootRequiredAfterUpdate:
                self.reportStall(
                    .updateNotRunning,
                    title: L("EgressView is not recording"),
                    body: L("The update is installed, but macOS is still running the previous version. Restart this Mac to resume monitoring. Traffic during this time is not being recorded.")
                )
            case .silentWhileActive(let since):
                self.reportStall(
                    .notRecording(silentSince: since),
                    title: L("EgressView is not recording"),
                    body: L("Monitoring reports that it is running, but nothing has been recorded for half an hour. Quit and reopen EgressView Agent to restart it. Traffic during this time is not being recorded.")
                )
            case .unanswered:
                let fallback = MonitoringHealthCheck.evaluateSilenceWithoutExtensionState(
                    lastObservationAt: latestObservationAt,
                    monitoringSince: forced
                        ? Date(timeIntervalSince1970: 0)
                        : self.gateState.monitoringSince
                )
                if case .silentWhileActive(let since) = fallback {
                    self.reportStall(
                        .notRecording(silentSince: since),
                        title: L("EgressView is not recording"),
                        body: L("macOS did not answer the monitoring health check, and nothing has been recorded for half an hour. Quit and reopen EgressView Agent to restart it. Traffic during this time may not be recorded.")
                    )
                }
            case .healthy:
                if self.gateState.stall != nil {
                    self.gateState.stall = nil
                    self.gateState.hasReportedStall = false
                    self.statusHandler(self.gateState.underlyingStatus)
                }
            case .notInstalled:
                self.statusHandler(.failed(L("Network monitoring System Extension is not installed.")))
            case .awaitingApproval:
                self.statusHandler(.approvalRequired)
            }
        }
    }

    /// Puts the agent into a "not recording" state and says so once.
    ///
    /// Once, not once per check: this runs every minute, and thirty notifications
    /// an hour is how a warning stops being read. The menu bar carries it from
    /// then on, which is the part that does not need permission from anyone.
    private func reportStall(
        _ status: AgentMonitoringStatus, title: String, body: String
    ) {
        gateState.stall = status
        statusHandler(status)
        guard !gateState.hasReportedStall else { return }
        gateState.hasReportedStall = true
        AgentUserNotifier.shared.notify(title: title, body: body)
    }

    func selectLightweightMonitoring() {
        guard ensureStorageAvailable() else { return }
        guard isLightweightMonitoringAvailable else {
            statusHandler(.failed(L(
                "Lightweight monitoring is unavailable in this sandboxed build. The current monitoring mode was not changed; use network monitoring."
            )))
            return
        }
        do {
            _ = try LibProcSocketSnapshotProvider(capacity: 1).snapshot()
        } catch {
            statusHandler(.failed(lightweightFailureMessage(error)))
            return
        }
        lightweightCollector?.stop()
        lightweightCollector = nil
        fullMonitoringCollector?.stop()
        statusHandler(.deactivating)
        extensionController.disableFilter { [weak self] result in
            switch result {
            case .success:
                self?.startLightweightCollector()
            case .failure(let error):
                self?.statusHandler(.failed(error.localizedDescription))
            }
        }
    }

    func restoreMonitoringState() {
        extensionController.isFilterEnabled { [weak self] result in
            switch result {
            case .success(true):
                self?.statusHandler(.fullActivationRequested)
                self?.activateFullMonitoring()
            case .success(false):
                self?.statusHandler(.paused)
            case .failure(let error):
                self?.statusHandler(.failed(error.localizedDescription))
            }
        }
    }

    func selectFullMonitoring() {
        guard ensureStorageAvailable() else { return }
        lightweightCollector?.stop()
        lightweightCollector = nil
        statusHandler(.fullActivationRequested)
        activateFullMonitoring()
    }

    func pause() {
        lightweightCollector?.stop()
        lightweightCollector = nil
        fullMonitoringCollector?.stop()
        statusHandler(.deactivating)
        extensionController.disableFilter { [weak self] result in
            switch result {
            case .success:
                self?.statusHandler(.paused)
            case .failure(let error):
                self?.statusHandler(.failed(error.localizedDescription))
            }
        }
    }

    /// Stops both collectors, disables the filter, then asks macOS to unregister
    /// the System Extension. `true` means removal is accepted but needs reboot.
    func prepareForUninstall(completion: @escaping (Result<Bool, Error>) -> Void) {
        lightweightCollector?.stop()
        lightweightCollector = nil
        fullMonitoringCollector?.stop()
        statusHandler(.deactivating)
        extensionController.deactivate(completion: completion)
    }

    private func startLightweightCollector() {
        let collector = LightweightCollector { [weak self] observations in
            guard let self else { return }
            if let store = self.store {
                do {
                    let sampled = self.persistenceSampler.observationsToPersist(observations)
                    try store.append(sampled)
                } catch {
                    self.storageErrorHandler(error)
                }
            }
            self.observationHandler(observations)
            self.statusHandler(.lightweight(observationCount: observations.count))
        }
        lightweightCollector = collector
        do {
            try collector.start()
        } catch {
            lightweightCollector = nil
            statusHandler(.failed(String(describing: error)))
        }
    }

    private func activateFullMonitoring() {
        extensionController.activate { [weak self] result in
            switch result {
            case .success:
                self?.fullMonitoringCollector?.start()
            case .failure(let error):
                self?.statusHandler(.failed(error.localizedDescription))
            }
        }
    }

    private func ensureStorageAvailable() -> Bool {
        guard store != nil else {
            let error = ObservationJournalError.appGroupUnavailable
            storageErrorHandler(error)
            statusHandler(.failed(error.localizedDescription))
            return false
        }
        return true
    }

    private func lightweightFailureMessage(_ error: Error) -> String {
        if let libProcError = error as? LibProcError,
           case .collectionFailed(let errorNumber) = libProcError,
           errorNumber == EPERM {
            return L(
                "Lightweight monitoring is unavailable in this sandboxed build. The current monitoring mode was not changed; use network monitoring."
            )
        }
        return error.localizedDescription
    }
}

private final class SystemExtensionController: NSObject, OSSystemExtensionRequestDelegate {
    private enum PendingOperation {
        case activation
        case deactivation
    }

    private static let approvalRetryDelay: TimeInterval = 2
    private static let approvalRetryLimit = 60

    private let identifier: String
    private let statusHandler: (AgentMonitoringStatus) -> Void
    private var approvalRetryWorkItem: DispatchWorkItem?
    private var approvalRetryCount = 0
    private var activationCompletion: ((Result<Void, Error>) -> Void)?
    private var deactivationCompletion: ((Result<Bool, Error>) -> Void)?
    private var pendingOperation: PendingOperation?

    init(identifier: String, statusHandler: @escaping (AgentMonitoringStatus) -> Void) {
        self.identifier = identifier
        self.statusHandler = statusHandler
    }

    func activate(completion: @escaping (Result<Void, Error>) -> Void) {
        cancelApprovalRecovery()
        activationCompletion = completion
        deactivationCompletion = nil
        pendingOperation = .activation
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: identifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func deactivate(completion: @escaping (Result<Bool, Error>) -> Void) {
        cancelApprovalRecovery()
        activationCompletion = nil
        deactivationCompletion = completion
        removeFilterConfiguration { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.finishDeactivation(.failure(error))
            case .success:
                self.pendingOperation = .deactivation
                let request = OSSystemExtensionRequest.deactivationRequest(
                    forExtensionWithIdentifier: self.identifier,
                    queue: .main
                )
                request.delegate = self
                OSSystemExtensionManager.shared.submitRequest(request)
            }
        }
    }

    private func removeFilterConfiguration(completion: @escaping (Result<Void, Error>) -> Void) {
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { error in
            if let error {
                completion(.failure(error))
                return
            }
            guard manager.providerConfiguration != nil || manager.isEnabled else {
                completion(.success(()))
                return
            }
            manager.removeFromPreferences { error in
                if let error {
                    completion(.failure(error))
                } else {
                    completion(.success(()))
                }
            }
        }
    }

    func disableFilter(completion: @escaping (Result<Void, Error>) -> Void) {
        cancelApprovalRecovery()
        activationCompletion = nil
        NEFilterManager.shared().loadFromPreferences { error in
            if let error {
                completion(.failure(error))
                return
            }
            let manager = NEFilterManager.shared()
            guard manager.isEnabled else {
                completion(.success(()))
                return
            }
            manager.isEnabled = false
            manager.saveToPreferences { error in
                if let error {
                    completion(.failure(error))
                } else {
                    completion(.success(()))
                }
            }
        }
    }

    func isFilterEnabled(completion: @escaping (Result<Bool, Error>) -> Void) {
        NEFilterManager.shared().loadFromPreferences { error in
            if let error {
                completion(.failure(error))
            } else {
                completion(.success(NEFilterManager.shared().isEnabled))
            }
        }
    }

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        let shortVersionComparison = ext.bundleShortVersion.compare(
            existing.bundleShortVersion,
            options: .numeric
        )
        if shortVersionComparison != .orderedSame {
            return shortVersionComparison == .orderedDescending ? .replace : .cancel
        }

        return ext.bundleVersion.compare(
            existing.bundleVersion,
            options: .numeric
        ) == .orderedDescending ? .replace : .cancel
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        if pendingOperation == .deactivation {
            statusHandler(.removalApprovalRequired)
        } else {
            statusHandler(.approvalRequired)
            scheduleApprovalRecovery()
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        if pendingOperation == .deactivation {
            switch result {
            case .completed:
                statusHandler(.paused)
                finishDeactivation(.success(false))
            case .willCompleteAfterReboot:
                statusHandler(.removalRebootRequired)
                finishDeactivation(.success(true))
            @unknown default:
                finishDeactivation(.failure(SystemExtensionActivationError.unknownResult))
            }
            return
        }
        switch result {
        case .completed:
            cancelApprovalRecovery()
            enableFilter { [weak self] result in
                self?.finishActivation(result)
            }
        case .willCompleteAfterReboot:
            activationCompletion = nil
            statusHandler(.rebootRequired)
        @unknown default:
            finishActivation(.failure(SystemExtensionActivationError.unknownResult))
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        cancelApprovalRecovery()
        if pendingOperation == .deactivation {
            let nsError = error as NSError
            if nsError.domain == OSSystemExtensionErrorDomain,
               nsError.code == OSSystemExtensionError.Code.extensionNotFound.rawValue {
                statusHandler(.paused)
                finishDeactivation(.success(false))
            } else {
                finishDeactivation(.failure(error))
            }
        } else {
            finishActivation(.failure(error))
        }
    }

    private func enableFilter(completion: @escaping (Result<Void, Error>) -> Void) {
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { [weak self] error in
            if let error {
                completion(.failure(error))
                return
            }
            let configuration = NEFilterProviderConfiguration()
            configuration.filterSockets = true
            configuration.filterPackets = false
            configuration.filterDataProviderBundleIdentifier = self?.identifier
            manager.providerConfiguration = configuration
            manager.localizedDescription = L("EgressView outbound connection metadata")
            manager.isEnabled = true
            manager.saveToPreferences { error in
                if let error {
                    completion(.failure(error))
                } else {
                    self?.statusHandler(.fullActivationRequested)
                    completion(.success(()))
                }
            }
        }
    }

    // Replacing a System Extension can remove its saved filter configuration
    // before macOS delivers the post-approval completion callback. Retry the
    // idempotent configuration save so approval can recover without another click.
    private func scheduleApprovalRecovery() {
        guard approvalRetryCount < Self.approvalRetryLimit else {
            statusHandler(.failed(L("System Extension approval was not detected in time")))
            return
        }

        approvalRetryCount += 1
        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.enableFilter { result in
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    switch result {
                    case .success:
                        self.cancelApprovalRecovery()
                    case .failure:
                        self.scheduleApprovalRecovery()
                    }
                }
            }
        }
        approvalRetryWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.approvalRetryDelay, execute: workItem)
    }

    private func cancelApprovalRecovery() {
        approvalRetryWorkItem?.cancel()
        approvalRetryWorkItem = nil
        approvalRetryCount = 0
    }

    private func finishActivation(_ result: Result<Void, Error>) {
        pendingOperation = nil
        let completion = activationCompletion
        activationCompletion = nil
        completion?(result)
    }

    private func finishDeactivation(_ result: Result<Bool, Error>) {
        pendingOperation = nil
        let completion = deactivationCompletion
        deactivationCompletion = nil
        completion?(result)
    }
}

private enum SystemExtensionActivationError: LocalizedError {
    case unknownResult

    var errorDescription: String? {
        L("Unknown System Extension activation result")
    }
}
