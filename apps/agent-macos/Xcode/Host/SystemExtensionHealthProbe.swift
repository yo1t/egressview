import EgressViewAgentCore
import Foundation
import SystemExtensions

/// Asks macOS which copies of the monitoring extension are installed, so the
/// app can tell whether it is still recording rather than assuming it is.
///
/// A separate object from `SystemExtensionController` on purpose: that one is
/// mid-activation half the time, and a health question must not be answerable
/// only while nothing else is happening.
final class SystemExtensionHealthProbe: NSObject, OSSystemExtensionRequestDelegate {
    private let identifier: String
    private let appBundleVersion: String
    private var completion: ((MonitoringHealth) -> Void)?
    private var found: [OSSystemExtensionProperties] = []

    init(identifier: String, appBundleVersion: String) {
        self.identifier = identifier
        self.appBundleVersion = appBundleVersion
    }

    func check(completion: @escaping (MonitoringHealth) -> Void) {
        self.completion = completion
        found = []
        let request = OSSystemExtensionRequest.propertiesRequest(
            forExtensionWithIdentifier: identifier, queue: .main
        )
        request.delegate = self
        OSSystemExtensionManager.shared.submitRequest(request)
    }

    func request(
        _ request: OSSystemExtensionRequest,
        foundProperties properties: [OSSystemExtensionProperties]
    ) {
        found = properties
    }

    func request(
        _ request: OSSystemExtensionRequest,
        didFinishWithResult result: OSSystemExtensionRequest.Result
    ) {
        let versions = found.map {
            SystemExtensionVersion(
                shortVersion: $0.bundleShortVersion,
                bundleVersion: $0.bundleVersion,
                isEnabled: $0.isEnabled,
                isAwaitingUserApproval: $0.isAwaitingUserApproval,
                isUninstalling: $0.isUninstalling
            )
        }
        finish(MonitoringHealthCheck.evaluate(
            versions: versions, appBundleVersion: appBundleVersion
        ))
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        // A failed question is not a failed answer. Saying "not installed"
        // here would replace a real status with a guess, so the caller is told
        // nothing and keeps whatever it already knew.
        completion = nil
        found = []
    }

    func requestNeedsUserApproval(_ request: OSSystemExtensionRequest) {
        finish(.awaitingApproval)
    }

    func request(
        _ request: OSSystemExtensionRequest,
        actionForReplacingExtension existing: OSSystemExtensionProperties,
        withExtension ext: OSSystemExtensionProperties
    ) -> OSSystemExtensionRequest.ReplacementAction {
        // A properties request never replaces anything; this is only here to
        // satisfy the protocol.
        .cancel
    }

    private func finish(_ health: MonitoringHealth) {
        let completion = self.completion
        self.completion = nil
        completion?(health)
    }
}
