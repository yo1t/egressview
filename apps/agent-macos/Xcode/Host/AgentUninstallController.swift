import AppKit
import EgressViewAgentCore
import Foundation

@MainActor
final class AgentUninstallController: ObservableObject {
    @Published var removeHistory = false
    @Published private(set) var isRunning = false
    @Published private(set) var needsManualHubRevocation = false
    @Published private(set) var isReadyToRemoveApplication = false
    @Published private(set) var status = L("Review what will be removed before continuing.")

    private let store: ObservationStore?
    private let monitoringController: AgentMonitoringController
    private let hubDelivery: HubDeliveryController
    private let launchController: LaunchAtLoginController
    private let credentialStore: any AgentCredentialStoring
    private let uninstallService: AgentUninstallService
    private let defaults: UserDefaults
    private let hubRevocationMarkerKey = "agentUninstallRevokedAgentID"
    private let onPreparedForRemoval: () -> Void

    init(
        store: ObservationStore?,
        monitoringController: AgentMonitoringController,
        hubDelivery: HubDeliveryController,
        launchController: LaunchAtLoginController,
        credentialStore: any AgentCredentialStoring = KeychainAgentCredentialStore(),
        defaults: UserDefaults = .standard,
        onPreparedForRemoval: @escaping () -> Void = {}
    ) {
        self.store = store
        self.monitoringController = monitoringController
        self.hubDelivery = hubDelivery
        self.launchController = launchController
        self.credentialStore = credentialStore
        self.uninstallService = AgentUninstallService(credentialStore: credentialStore)
        self.defaults = defaults
        self.onPreparedForRemoval = onPreparedForRemoval
    }

    func begin() {
        run(allowManualHubRevocation: false)
    }

    func continueWithoutHub() {
        run(allowManualHubRevocation: true)
    }

    func revealApplication() {
        NSWorkspace.shared.activateFileViewerSelecting([Bundle.main.bundleURL])
    }

    func refreshLocalization() {
        if !isRunning && !needsManualHubRevocation && !isReadyToRemoveApplication {
            status = L("Review what will be removed before continuing.")
        }
    }

    private func run(allowManualHubRevocation: Bool) {
        guard !isRunning else { return }
        isRunning = true
        needsManualHubRevocation = false
        isReadyToRemoveApplication = false
        status = L("Stopping Hub delivery...")

        Task {
            await hubDelivery.stopForUninstall()
            if !allowManualHubRevocation {
                status = L("Revoking this Mac at the Hub...")
                do {
                    if try !hasRecordedHubRevocation() {
                        let revoked = try await uninstallService.revokeHubRegistration()
                        if revoked, let credential = try credentialStore.load() {
                            defaults.set(credential.agentID.uuidString, forKey: hubRevocationMarkerKey)
                        }
                    }
                } catch {
                    isRunning = false
                    needsManualHubRevocation = true
                    status = L("The Hub could not be reached or refused revocation. Retry, or continue locally and revoke this Mac from the Hub settings.")
                    return
                }
            }

            status = L("Removing the System Extension...")
            let extensionResult = await deactivateSystemExtension()
            switch extensionResult {
            case .failure(let error):
                isRunning = false
                status = L("System Extension removal failed: %@", error.localizedDescription)
                return
            case .success(let rebootRequired):
                do {
                    try launchController.disable()
                    try credentialStore.delete()
                    defaults.removeObject(forKey: hubRevocationMarkerKey)
                    try AgentDeliveryQueue.removePersistedQueue()
                    if removeHistory, let store {
                        _ = try store.removeAll()
                    }
                    isRunning = false
                    isReadyToRemoveApplication = true
                    onPreparedForRemoval()
                    status = rebootRequired
                        ? L("Local cleanup is complete. Move the app to Trash, then restart macOS to finish removing the System Extension.")
                        : L("Cleanup is complete. Move the app to Trash to finish uninstalling.")
                } catch {
                    isRunning = false
                    status = L("Local cleanup was incomplete: %@", error.localizedDescription)
                }
            }
        }
    }

    private func hasRecordedHubRevocation() throws -> Bool {
        guard let credential = try credentialStore.load() else { return true }
        return defaults.string(forKey: hubRevocationMarkerKey) == credential.agentID.uuidString
    }

    private func deactivateSystemExtension() async -> Result<Bool, Error> {
        await withCheckedContinuation { continuation in
            monitoringController.prepareForUninstall { result in
                continuation.resume(returning: result)
            }
        }
    }
}
