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
    private let extensionController: SystemExtensionController
    private var lightweightCollector: LightweightCollector?

    init(statusHandler: @escaping (AgentMonitoringStatus) -> Void) {
        self.statusHandler = statusHandler
        self.extensionController = SystemExtensionController(
            identifier: Self.systemExtensionIdentifier,
            statusHandler: statusHandler
        )
    }

    func selectLightweightMonitoring() {
        lightweightCollector?.stop()
        lightweightCollector = nil
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

    func selectFullMonitoring() {
        lightweightCollector?.stop()
        lightweightCollector = nil
        statusHandler(.fullActivationRequested)
        extensionController.activate()
    }

    func pause() {
        lightweightCollector?.stop()
        lightweightCollector = nil
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
            self?.statusHandler(.lightweight(observationCount: observations.count))
        }
        lightweightCollector = collector
        do {
            try collector.start()
        } catch {
            lightweightCollector = nil
            statusHandler(.failed(String(describing: error)))
        }
    }
}

private final class SystemExtensionController: NSObject, OSSystemExtensionRequestDelegate {
    private let identifier: String
    private let statusHandler: (AgentMonitoringStatus) -> Void

    init(identifier: String, statusHandler: @escaping (AgentMonitoringStatus) -> Void) {
        self.identifier = identifier
        self.statusHandler = statusHandler
    }

    func activate() {
        let request = OSSystemExtensionRequest.activationRequest(
            forExtensionWithIdentifier: identifier,
            queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func disableFilter(completion: @escaping (Result<Void, Error>) -> Void) {
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

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        ext.bundleShortVersion.compare(
            existing.bundleShortVersion,
            options: .numeric
        ) == .orderedDescending ? .replace : .cancel
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        statusHandler(.approvalRequired)
    }

    func request(_ request: OSSystemExtensionRequest, didFinishWithResult result: OSSystemExtensionRequest.Result) {
        switch result {
        case .completed:
            enableFilter()
        case .willCompleteAfterReboot:
            statusHandler(.rebootRequired)
        @unknown default:
            statusHandler(.failed("Unknown System Extension activation result"))
        }
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        statusHandler(.failed(error.localizedDescription))
    }

    private func enableFilter() {
        let manager = NEFilterManager.shared()
        manager.loadFromPreferences { [weak self] error in
            if let error {
                self?.statusHandler(.failed(error.localizedDescription))
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
                    self?.statusHandler(.failed(error.localizedDescription))
                } else {
                    self?.statusHandler(.fullActive)
                }
            }
        }
    }
}
