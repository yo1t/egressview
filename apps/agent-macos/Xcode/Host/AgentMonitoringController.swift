import EgressViewAgentCore
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
    case failed(String)

    var label: String {
        switch self {
        case .paused: return "Monitoring paused"
        case .lightweight(let count): return "Lightweight monitoring: \(count) connections"
        case .fullActivationRequested: return "Requesting Full monitoring approval..."
        case .fullActive: return "Full monitoring active"
        case .approvalRequired: return "Approve the System Extension in System Settings"
        case .rebootRequired: return "Restart macOS to finish enabling Full monitoring"
        case .deactivating: return "Stopping monitoring..."
        case .failed(let message): return "Monitoring failed: \(message)"
        }
    }

    var menuBarLabel: String {
        switch self {
        case .paused: return "EgressView: Paused"
        case .lightweight: return "EgressView: Light"
        case .fullActive: return "EgressView: Full"
        case .fullActivationRequested, .approvalRequired: return "EgressView: Approval"
        case .rebootRequired: return "EgressView: Restart"
        case .deactivating: return "EgressView: Stopping"
        case .failed: return "EgressView: Error"
        }
    }
}

final class AgentMonitoringController {
    static let systemExtensionIdentifier = "com.egressview.agent.filter"

    private let statusHandler: (AgentMonitoringStatus) -> Void
    private let journal: ObservationJournal?
    private let observationHandler: ([ConnectionObservation]) -> Void
    private let storageErrorHandler: (Error) -> Void
    private let extensionController: SystemExtensionController
    private var lightweightCollector: LightweightCollector?
    private var fullMonitoringCollector: FullMonitoringCollector?
    private var persistenceSampler = ObservationPersistenceSampler()

    init(
        journal: ObservationJournal?,
        statusHandler: @escaping (AgentMonitoringStatus) -> Void,
        observationHandler: @escaping ([ConnectionObservation]) -> Void,
        storageErrorHandler: @escaping (Error) -> Void
    ) {
        self.journal = journal
        self.statusHandler = statusHandler
        self.observationHandler = observationHandler
        self.storageErrorHandler = storageErrorHandler
        self.extensionController = SystemExtensionController(
            identifier: Self.systemExtensionIdentifier,
            statusHandler: statusHandler
        )
        if let journal {
            self.fullMonitoringCollector = FullMonitoringCollector(
                journal: journal,
                observationHandler: observationHandler,
                statusHandler: statusHandler,
                errorHandler: storageErrorHandler
            )
        }
    }

    func selectLightweightMonitoring() {
        guard ensureStorageAvailable() else { return }
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

    private func startLightweightCollector() {
        let collector = LightweightCollector { [weak self] observations in
            guard let self else { return }
            if let journal = self.journal {
                do {
                    let sampled = self.persistenceSampler.observationsToPersist(observations)
                    try journal.append(sampled)
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
        guard journal != nil else {
            let error = ObservationJournalError.appGroupUnavailable
            storageErrorHandler(error)
            statusHandler(.failed(error.localizedDescription))
            return false
        }
        return true
    }
}

private final class SystemExtensionController: NSObject, OSSystemExtensionRequestDelegate {
    private static let approvalRetryDelay: TimeInterval = 2
    private static let approvalRetryLimit = 60

    private let identifier: String
    private let statusHandler: (AgentMonitoringStatus) -> Void
    private var approvalRetryWorkItem: DispatchWorkItem?
    private var approvalRetryCount = 0
    private var activationCompletion: ((Result<Void, Error>) -> Void)?

    init(identifier: String, statusHandler: @escaping (AgentMonitoringStatus) -> Void) {
        self.identifier = identifier
        self.statusHandler = statusHandler
    }

    func activate(completion: @escaping (Result<Void, Error>) -> Void) {
        cancelApprovalRecovery()
        activationCompletion = completion
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: identifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
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
        statusHandler(.approvalRequired)
        scheduleApprovalRecovery()
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
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
        finishActivation(.failure(error))
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
            manager.localizedDescription = "EgressView outbound connection metadata"
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
            statusHandler(.failed("System Extension approval was not detected in time"))
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
        let completion = activationCompletion
        activationCompletion = nil
        completion?(result)
    }
}

private enum SystemExtensionActivationError: LocalizedError {
    case unknownResult

    var errorDescription: String? {
        "Unknown System Extension activation result"
    }
}
