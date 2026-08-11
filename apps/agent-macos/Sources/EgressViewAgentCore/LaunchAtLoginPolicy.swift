public enum LaunchAtLoginState: Equatable, Sendable {
    case disabled
    case enabled
    case requiresApproval
    case unavailable
}

public enum LaunchAtLoginAction: Equatable, Sendable {
    case register
    case unregister
    case openSystemSettings
}

public enum LaunchAtLoginPolicy {
    public static func action(for state: LaunchAtLoginState) -> LaunchAtLoginAction {
        switch state {
        case .disabled:
            return .register
        case .enabled:
            return .unregister
        case .requiresApproval:
            return .openSystemSettings
        case .unavailable:
            return .register
        }
    }
}
