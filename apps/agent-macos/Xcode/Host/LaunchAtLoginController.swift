import EgressViewAgentCore
import ServiceManagement

final class LaunchAtLoginController {
    private static let optOutKey = "launchAtLoginUserOptOut"
    private let service: SMAppService
    private let defaults: UserDefaults

    init(service: SMAppService = .mainApp, defaults: UserDefaults = .standard) {
        self.service = service
        self.defaults = defaults
    }

    var state: LaunchAtLoginState {
        switch service.status {
        case .notRegistered:
            return .disabled
        case .enabled:
            return .enabled
        case .requiresApproval:
            return .requiresApproval
        case .notFound:
            return .unavailable
        @unknown default:
            return .unavailable
        }
    }

    func toggle() throws {
        switch LaunchAtLoginPolicy.action(for: state) {
        case .none:
            break
        case .register:
            try service.register()
            defaults.set(false, forKey: Self.optOutKey)
        case .unregister:
            try service.unregister()
            defaults.set(true, forKey: Self.optOutKey)
        case .openSystemSettings:
            SMAppService.openSystemSettingsLoginItems()
        }
    }

    func ensureEnabledForMonitoring() throws {
        switch LaunchAtLoginPolicy.automaticAction(
            for: state,
            monitoringActive: true,
            userOptedOut: defaults.bool(forKey: Self.optOutKey)
        ) {
        case .register:
            try service.register()
        case .none, .unregister, .openSystemSettings:
            break
        }
    }

    func disable() throws {
        switch state {
        case .enabled, .requiresApproval:
            try service.unregister()
        case .disabled, .unavailable:
            break
        }
    }
}
