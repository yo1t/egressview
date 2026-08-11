import EgressViewAgentCore
import ServiceManagement

final class LaunchAtLoginController {
    private let service: SMAppService

    init(service: SMAppService = .mainApp) {
        self.service = service
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
        case .register:
            try service.register()
        case .unregister:
            try service.unregister()
        case .openSystemSettings:
            SMAppService.openSystemSettingsLoginItems()
        }
    }
}
