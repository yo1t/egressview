import Foundation

@objc public protocol FullMonitoringXPCProtocol {
    func drainObservations(withReply reply: @escaping (Data) -> Void)
    /// Optional so a new Host can keep collecting from the previous extension
    /// while macOS is still completing an update.
    @objc optional func readQUICFeasibilityDiagnostics(withReply reply: @escaping (Data) -> Void)
    /// Synchronizes the explicit user opt-in without relying on preferences
    /// containers, which are not shared between a user app and a system daemon.
    @objc optional func setReadsServerName(_ enabled: Bool, withReply reply: @escaping () -> Void)
}

public enum FullMonitoringXPC {
    // NetworkExtension requires this name to begin with an App Group
    // entitlement. The build suffix is also required: launchd retains the old
    // provider's endpoint while a System Extension update is being completed,
    // so reusing one fixed name can leave the new provider unable to register
    // until macOS restarts.
    public static let machServiceName = "group.com.egressview.agent.xpc.121"
    public static let hostBundleIdentifier = "com.egressview.agent.macos"

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}
