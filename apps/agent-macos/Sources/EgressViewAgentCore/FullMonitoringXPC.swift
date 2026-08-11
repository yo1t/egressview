import Foundation

@objc public protocol FullMonitoringXPCProtocol {
    func drainObservations(withReply reply: @escaping (Data) -> Void)
}

public enum FullMonitoringXPC {
    public static let machServiceName = "group.com.egressview.agent.xpc"
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
