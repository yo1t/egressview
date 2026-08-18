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
    /// The request in flight.
    ///
    /// Held because nothing else does. `submitRequest` does not keep the
    /// request alive, and a request that is released before macOS answers is
    /// never answered at all -- no `didFinishWithResult`, no `didFailWithError`,
    /// no callback of any kind. Measured on 2026-08-19: zero delegate calls in
    /// 200 seconds.
    private var request: OSSystemExtensionRequest?
    private var timeout: DispatchWorkItem?
    private var found: [OSSystemExtensionProperties] = []
    private var lastObservationAt: Date?
    private var awakeSince: Date?

    init(identifier: String, appBundleVersion: String) {
        self.identifier = identifier
        self.appBundleVersion = appBundleVersion
    }

    /// `lastObservationAt` is what decides the verdict. The installed versions
    /// say a swap is pending; only the record says whether it stopped anything.
    /// How long macOS is given to answer.
    ///
    /// It has to be given a limit, because it does not always answer at all.
    /// Measured on 2026-08-19: four consecutive property requests produced no
    /// `didFinishWithResult`, no `didFailWithError`, and no
    /// `requestNeedsUserApproval` -- nothing. A question that is never answered
    /// left this check silent, and silence read as health. That is the same
    /// shape as the fault the check exists to catch.
    static let answerTimeout: TimeInterval = 20

    func check(
        lastObservationAt: Date?,
        awakeSince: Date?,
        completion: @escaping (MonitoringHealth) -> Void
    ) {
        self.completion = completion
        self.lastObservationAt = lastObservationAt
        self.awakeSince = awakeSince
        found = []
        let request = OSSystemExtensionRequest.propertiesRequest(
            forExtensionWithIdentifier: identifier, queue: .main
        )
        request.delegate = self
        self.request = request
        OSSystemExtensionManager.shared.submitRequest(request)

        // An unanswered question is reported as unanswered, not as nothing.
        let timeout = DispatchWorkItem { [weak self] in
            self?.finish(.unanswered)
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.answerTimeout, execute: timeout)
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
            versions: versions,
            appBundleVersion: appBundleVersion,
            lastObservationAt: lastObservationAt,
            awakeSince: awakeSince
        ))
    }

    func request(_ request: OSSystemExtensionRequest, didFailWithError error: Error) {
        // A failed question is not a failed answer: it must not become
        // "not installed", which would replace a real status with a guess. But
        // it must not vanish either -- the caller needs to know the question
        // went unanswered, so it can say so rather than implying health.
        finish(.unanswered)
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
        timeout?.cancel()
        timeout = nil
        let completion = self.completion
        self.completion = nil
        self.request = nil
        completion?(health)
    }
}
