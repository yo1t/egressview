import EgressViewAgentCore
import EgressViewNetworkExtension
import Foundation
import OSLog
import Security

final class FullMonitoringXPCServer: NSObject, NSXPCListenerDelegate, FullMonitoringXPCProtocol {
    static let shared = FullMonitoringXPCServer()

    private let logger = Logger(subsystem: "com.egressview.agent.filter", category: "xpc")
    private let lock = NSLock()
    private let maximumBufferedObservations = 10_000
    private var observations: [ConnectionObservation] = []
    private var quicDiagnostics = QUICFeasibilityDiagnostics()
    private var readsServerName = false
    private lazy var listener = NSXPCListener(machServiceName: FullMonitoringXPC.machServiceName)

    func start() {
        listener.delegate = self
        listener.resume()
    }

    func enqueue(_ observation: ConnectionObservation) {
        lock.withLock {
            if observations.count == maximumBufferedObservations {
                observations.removeFirst()
            }
            observations.append(observation)
        }
    }

    func drainObservations(withReply reply: @escaping (Data) -> Void) {
        let pending: [ConnectionObservation] = lock.withLock {
            defer { observations.removeAll(keepingCapacity: true) }
            return observations
        }
        do {
            reply(try FullMonitoringXPC.encoder().encode(pending))
        } catch {
            logger.error("Could not encode observations: \(error.localizedDescription, privacy: .public)")
            reply(Data())
        }
    }

    func record(_ event: QUICFeasibilityEvent) {
        lock.withLock {
            switch event {
            case .udp443Flow:
                quicDiagnostics.recordUDP443Flow()
            case let .outboundCallback(offset, byteCount, classification):
                quicDiagnostics.recordOutboundCallback(
                    offset: offset,
                    byteCount: byteCount,
                    classification: classification
                )
            }
        }
    }

    func readQUICFeasibilityDiagnostics(withReply reply: @escaping (Data) -> Void) {
        let snapshot = lock.withLock { quicDiagnostics }
        do {
            reply(try FullMonitoringXPC.encoder().encode(snapshot))
        } catch {
            logger.error("Could not encode QUIC feasibility diagnostics: \(error.localizedDescription, privacy: .public)")
            reply(Data())
        }
    }

    func setReadsServerName(_ enabled: Bool, withReply reply: @escaping () -> Void) {
        lock.withLock { readsServerName = enabled }
        reply()
    }

    var isServerNameReadingEnabled: Bool {
        lock.withLock { readsServerName }
    }

    func listener(
        _ listener: NSXPCListener,
        shouldAcceptNewConnection newConnection: NSXPCConnection
    ) -> Bool {
        guard isTrustedHost(newConnection) else {
            logger.error("Rejected an untrusted Full monitoring XPC client")
            return false
        }
        newConnection.exportedInterface = NSXPCInterface(with: FullMonitoringXPCProtocol.self)
        newConnection.exportedObject = self
        newConnection.resume()
        return true
    }

    private func isTrustedHost(_ connection: NSXPCConnection) -> Bool {
        let attributes = [
            kSecGuestAttributePid as String: NSNumber(value: connection.processIdentifier),
        ] as CFDictionary
        var guestCode: SecCode?
        let guestStatus = SecCodeCopyGuestWithAttributes(nil, attributes, [], &guestCode)
        guard guestStatus == errSecSuccess, let guestCode else {
            logger.error("Could not resolve XPC client code: OSStatus (guestStatus, privacy: .public)")
            return false
        }
        var guestStaticCode: SecStaticCode?
        let staticStatus = SecCodeCopyStaticCode(guestCode, [], &guestStaticCode)
        guard staticStatus == errSecSuccess, let guestStaticCode else {
            logger.error("Could not resolve XPC client static code: OSStatus (staticStatus, privacy: .public)")
            return false
        }

        guard let teamIdentifier = signingTeamIdentifier() else {
            logger.error("Could not determine the System Extension signing team")
            return false
        }
        let requirementText = "anchor apple generic and identifier \"\(FullMonitoringXPC.hostBundleIdentifier)\" and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
        var requirement: SecRequirement?
        let requirementStatus = SecRequirementCreateWithString(requirementText as CFString, [], &requirement)
        guard requirementStatus == errSecSuccess, let requirement else {
            logger.error("Could not create the XPC client requirement: OSStatus \(requirementStatus, privacy: .public)")
            return false
        }
        var validationError: Unmanaged<CFError>?
        let validationFlags = SecCSFlags(
            rawValue: kSecCSStrictValidate | kSecCSCheckAllArchitectures
        )
        let validationStatus = SecStaticCodeCheckValidityWithErrors(
            guestStaticCode,
            validationFlags,
            requirement,
            &validationError
        )
        guard validationStatus == errSecSuccess else {
            let detail = validationError?.takeRetainedValue().localizedDescription ?? "unknown"
            logger.error("XPC client signature validation failed: OSStatus \(validationStatus, privacy: .public), \(detail, privacy: .public)")
            return false
        }
        return true
    }

    private func signingTeamIdentifier() -> String? {
        var ownCode: SecCode?
        let ownCodeStatus = SecCodeCopySelf([], &ownCode)
        guard ownCodeStatus == errSecSuccess, let ownCode else {
            logger.error("Could not resolve the System Extension code: OSStatus \(ownCodeStatus, privacy: .public)")
            return nil
        }
        var staticCode: SecStaticCode?
        let staticCodeStatus = SecCodeCopyStaticCode(ownCode, [], &staticCode)
        guard staticCodeStatus == errSecSuccess, let staticCode else {
            logger.error("Could not resolve the System Extension static code: OSStatus \(staticCodeStatus, privacy: .public)")
            return nil
        }
        var signingInformation: CFDictionary?
        let signingInformationStatus = SecCodeCopySigningInformation(
            staticCode,
            SecCSFlags(rawValue: kSecCSSigningInformation),
            &signingInformation
        )
        guard signingInformationStatus == errSecSuccess,
              let information = signingInformation as? [String: Any] else {
            logger.error("Could not read the System Extension signing information: OSStatus \(signingInformationStatus, privacy: .public)")
            return nil
        }
        guard let teamIdentifier = information[kSecCodeInfoTeamIdentifier as String] as? String,
              !teamIdentifier.isEmpty else {
            logger.error("System Extension signing information did not include a Team ID")
            return nil
        }
        return teamIdentifier
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
