import EgressViewAgentCore
import Darwin
import Foundation
import NetworkExtension
import SystemExtensions

enum AgentMonitoringStatus: Equatable {
    case paused
    case lightweight(observationCount: Int)
    case fullActivationRequested
    case fullActive
    case approvalRequired
    case rebootRequired
    case deactivating
    case removalApprovalRequired
    case removalRebootRequired
    case failed(String)

    var label: String {
        switch self {
        case .paused: return L("Monitoring paused")
        case .lightweight(let count): return L("Lightweight monitoring: %lld connections", count)
        case .fullActivationRequested: return L("Requesting network monitoring approval...")
        case .fullActive: return L("Network monitoring active")
        case .approvalRequired: return L("Approve the System Extension in System Settings")
        case .rebootRequired: return L("Restart macOS to finish enabling network monitoring")
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
        case .fullActivationRequested, .approvalRequired, .rebootRequired,
             .removalApprovalRequired, .removalRebootRequired, .failed:
            return "MenuBarAttention"
        }
    }

    var menuBarLabel: String {
        switch self {
        case .paused: return L("EgressView: Paused")
        case .lightweight: return L("EgressView: Light")
        case .fullActive: return L("EgressView: Monitoring")
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

    private let statusHandler: (AgentMonitoringStatus) -> Void
    private let store: ObservationStore?
    private let observationHandler: ([ConnectionObservation]) -> Void
    private let storageErrorHandler: (Error) -> Void
    private let extensionController: SystemExtensionController
    private var lightweightCollector: LightweightCollector?
    private var fullMonitoringCollector: FullMonitoringCollector?
    private var persistenceSampler = ObservationPersistenceSampler()

    init(
        store: ObservationStore?,
        statusHandler: @escaping (AgentMonitoringStatus) -> Void,
        observationHandler: @escaping ([ConnectionObservation]) -> Void,
        storageErrorHandler: @escaping (Error) -> Void
    ) {
        self.store = store
        self.statusHandler = statusHandler
        self.observationHandler = observationHandler
        self.storageErrorHandler = storageErrorHandler
        self.extensionController = SystemExtensionController(
            identifier: Self.systemExtensionIdentifier,
            statusHandler: statusHandler
        )
        if let store {
            self.fullMonitoringCollector = FullMonitoringCollector(
                store: store,
                observationHandler: observationHandler,
                statusHandler: statusHandler,
                errorHandler: storageErrorHandler
            )
        }
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
