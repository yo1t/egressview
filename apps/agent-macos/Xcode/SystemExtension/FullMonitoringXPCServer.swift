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
    private lazy var handoff = ObservationHandoff(capacity: maximumBufferedObservations)
    private var quicDiagnostics = QUICFeasibilityDiagnostics()
    private var flowDiagnostics = FlowCaptureDiagnostics()
    private var readsServerName = false
    private lazy var listener = NSXPCListener(machServiceName: FullMonitoringXPC.machServiceName)

    func start() {
        listener.delegate = self
        listener.resume()
    }

    func enqueue(_ observation: ConnectionObservation) {
        lock.withLock {
            if handoff.enqueue(observation) {
                flowDiagnostics.record(.droppedObservation)
            }
            flowDiagnostics.record(.enqueuedObservation)
        }
    }

    /// Without acknowledgement: whatever is waiting, handed over once. Kept
    /// for a caller that does not acknowledge; a batch in flight under the
    /// acknowledged method is left for that method to resend.
    func drainObservations(withReply reply: @escaping (Data) -> Void) {
        let pending = lock.withLock { handoff.takePendingWithoutAcknowledgement() }
        reply(encode(pending) ?? Data())
    }

    func drainObservations(
        acknowledging acknowledgement: Int64,
        withReply reply: @escaping (Int64, Data) -> Void
    ) {
        let (batch, isResend) = lock.withLock { handoff.take(acknowledging: acknowledgement) }
        guard let batch else {
            reply(0, Data())
            return
        }
        if isResend {
            // Rare: the app did not confirm the last batch. Worth one line, so
            // a run of them can be seen.
            logger.log("handing over batch \(batch.id, privacy: .public) again: \(batch.observations.count, privacy: .public) observations")
        } else {
            lock.withLock { flowDiagnostics.recordDrained(batch.observations.count) }
        }
        // An observation that cannot be encoded cannot be handed over at all;
        // the empty reply is acknowledged like any other and counted as a failure.
        reply(batch.id, encode(batch.observations) ?? Data())
    }

    private func encode(_ observations: [ConnectionObservation]) -> Data? {
        do {
            return try FullMonitoringXPC.encoder().encode(observations)
        } catch {
            lock.withLock { flowDiagnostics.record(.encodingFailure) }
            logger.error("Could not encode observations: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func recordFlowCapture(_ stage: FlowCaptureDiagnostics.Stage) {
        lock.withLock { flowDiagnostics.record(stage) }
    }

    func readFlowCaptureDiagnostics(withReply reply: @escaping (Data) -> Void) {
        let snapshot = lock.withLock { flowDiagnostics }
        reply((try? FullMonitoringXPC.encoder().encode(snapshot)) ?? Data())
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
            case let .assembly(outcome):
                switch outcome {
                case .name: quicDiagnostics.recordServerNameFound()
                case .needsMore: quicDiagnostics.recordAwaitingMoreDatagrams()
                case .notInitial: break
                }
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
        guard let requirement = hostRequirement() else { return false }
        // Checked by the system against the connecting process itself, through
        // its audit token, for every message. The check this replaces looked the
        // client up by process ID and validated the file on disk: a process can
        // connect and then exec the signed app under the same ID, and pass a
        // check made against what it became (P2-102).
        newConnection.setCodeSigningRequirement(requirement)
        newConnection.exportedInterface = NSXPCInterface(with: FullMonitoringXPCProtocol.self)
        newConnection.exportedObject = self
        newConnection.resume()
        return true
    }

    /// The app this extension serves: this bundle identifier, signed by the
    /// same team as the extension.
    private func hostRequirement() -> String? {
        guard let teamIdentifier = signingTeamIdentifier() else {
            logger.error("Could not determine the System Extension signing team")
            return nil
        }
        return "anchor apple generic and identifier \"\(FullMonitoringXPC.hostBundleIdentifier)\" and certificate leaf[subject.OU] = \"\(teamIdentifier)\""
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
