import EgressViewAgentCore
import Foundation

final class FullMonitoringCollector {
    private let store: ObservationStore
    private let observationHandler: ([ConnectionObservation]) -> Void
    private let statusHandler: (AgentMonitoringStatus) -> Void
    private let errorHandler: (Error) -> Void
    private let coverageHandler: () -> Void
    private let recoveryHandler: () -> Void
    private let diagnosticsHandler: (QUICFeasibilityDiagnostics) -> Void
    private let queue = DispatchQueue(label: "com.egressview.agent.full-monitoring")
    private var connection: NSXPCConnection?
    private var diagnosticsConnection: NSXPCConnection?
    private var timer: DispatchSourceTimer?
    /// True while a drain request is out. Guards against stacking requests on
    /// an extension that has stopped answering.
    private var isDraining = false
    private var isReadingDiagnostics = false
    private var diagnosticsRequestGeneration: UInt64 = 0
    private var readsServerName: Bool
    private var needsServerNamePolicySync = true

    /// How long a drain may go unanswered before the connection is replaced.
    ///
    /// Ten polls' worth. Long enough that a busy extension is not torn down for
    /// being slow, short enough that a dead one is noticed within seconds
    /// rather than never.
    private static let drainTimeout: TimeInterval = 10
    private var reportedActive = false
    private var reportedStarting = false
    private var isRunning = false

    init(
        store: ObservationStore,
        observationHandler: @escaping ([ConnectionObservation]) -> Void,
        statusHandler: @escaping (AgentMonitoringStatus) -> Void,
        errorHandler: @escaping (Error) -> Void,
        coverageHandler: @escaping () -> Void = {},
        recoveryHandler: @escaping () -> Void = {},
        readsServerName: Bool = false,
        diagnosticsHandler: @escaping (QUICFeasibilityDiagnostics) -> Void = { _ in }
    ) {
        self.store = store
        self.observationHandler = observationHandler
        self.statusHandler = statusHandler
        self.errorHandler = errorHandler
        self.coverageHandler = coverageHandler
        self.recoveryHandler = recoveryHandler
        self.readsServerName = readsServerName
        self.diagnosticsHandler = diagnosticsHandler
    }

    func start() {
        queue.async { [weak self] in self?.startOnQueue() }
    }

    func stop() {
        queue.async { [weak self] in self?.stopOnQueue() }
    }

    func setReadsServerName(_ enabled: Bool) {
        queue.async { [weak self] in
            guard let self else { return }
            self.readsServerName = enabled
            self.needsServerNamePolicySync = true
            guard let connection = self.connection,
                  let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
                      self?.queue.async { self?.resetConnection() }
                  }) as? FullMonitoringXPCProtocol else { return }
            self.syncServerNamePolicyIfNeeded(proxy)
        }
    }

    private func startOnQueue() {
        stopOnQueue()
        isRunning = true
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now(), repeating: 1)
        timer.setEventHandler { [weak self] in self?.poll() }
        self.timer = timer
        timer.resume()
    }

    private func stopOnQueue() {
        isRunning = false
        isDraining = false
        isReadingDiagnostics = false
        timer?.cancel()
        timer = nil
        connection?.invalidate()
        connection = nil
        finishDiagnosticsRequest()
        reportedActive = false
        reportedStarting = false
    }

    private func poll() {
        guard isRunning else { return }
        // One question at a time.
        //
        // The timer fires every second regardless of whether the last request
        // came back. If the extension ever stops replying, that produces a new
        // request and a retained reply block every second -- eighty thousand of
        // them in a day -- and nothing here would notice or say so.
        //
        // Not the cause of the CPU measured on 2026-08-20, and worth fixing on
        // its own: an unanswered request currently waits for ever.
        guard !isDraining else { return }
        isDraining = true
        let deadline = DispatchTime.now() + Self.drainTimeout
        queue.asyncAfter(deadline: deadline) { [weak self] in
            guard let self, self.isDraining else { return }
            // The reply never came. Drop the connection so the next tick starts
            // a fresh one rather than queueing behind a dead one.
            self.isDraining = false
            self.resetConnection()
        }
        let connection = connection ?? makeConnection()
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
            self?.queue.async {
                self?.isDraining = false
                self?.resetConnection()
            }
        }) as? FullMonitoringXPCProtocol else {
            isDraining = false
            resetConnection()
            return
        }
        syncServerNamePolicyIfNeeded(proxy)
        proxy.drainObservations { [weak self] data in
            self?.queue.async {
                self?.isDraining = false
                self?.consume(data)
            }
        }
    }

    private func syncServerNamePolicyIfNeeded(_ proxy: FullMonitoringXPCProtocol) {
        guard needsServerNamePolicySync else { return }
        needsServerNamePolicySync = false
        // Calls on one XPC connection are ordered, so the extension applies the
        // policy before the following drain. An older extension simply ignores
        // this optional method and remains fail-closed.
        _ = proxy.setReadsServerName?(readsServerName, withReply: {})
    }

    func requestQUICDiagnostics() {
        queue.async { [weak self] in self?.requestQUICDiagnosticsOnQueue() }
    }

    private func requestQUICDiagnosticsOnQueue() {
        guard isRunning else { return }
        guard !isReadingDiagnostics else { return }
        isReadingDiagnostics = true
        diagnosticsRequestGeneration &+= 1
        let generation = diagnosticsRequestGeneration
        let connection = NSXPCConnection(
            machServiceName: FullMonitoringXPC.machServiceName,
            options: .privileged
        )
        connection.remoteObjectInterface = NSXPCInterface(with: FullMonitoringXPCProtocol.self)
        connection.interruptionHandler = { [weak self] in
            self?.queue.async { self?.finishDiagnosticsRequest(generation: generation) }
        }
        connection.invalidationHandler = { [weak self] in
            self?.queue.async { self?.finishDiagnosticsRequest(generation: generation) }
        }
        connection.resume()
        diagnosticsConnection = connection
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
            self?.queue.async { self?.finishDiagnosticsRequest(generation: generation) }
        }) as? FullMonitoringXPCProtocol else {
            finishDiagnosticsRequest(generation: generation)
            return
        }
        let request: Void? = proxy.readQUICFeasibilityDiagnostics?(withReply: { [weak self] data in
            self?.queue.async {
                guard let self else { return }
                guard generation == self.diagnosticsRequestGeneration else { return }
                defer { self.finishDiagnosticsRequest(generation: generation) }
                guard self.isRunning, !data.isEmpty else { return }
                do {
                    let diagnostics = try FullMonitoringXPC.decoder().decode(
                        QUICFeasibilityDiagnostics.self,
                        from: data
                    )
                    self.diagnosticsHandler(diagnostics)
                } catch {
                    self.errorHandler(error)
                }
            }
        })
        if request == nil {
            finishDiagnosticsRequest(generation: generation)
        }
        queue.asyncAfter(deadline: .now() + 5) { [weak self] in
            // Diagnostics must never stack or affect observation collection if
            // an older extension does not implement the optional method.
            self?.finishDiagnosticsRequest(generation: generation)
        }
    }

    private func finishDiagnosticsRequest(generation: UInt64? = nil) {
        if let generation, generation != diagnosticsRequestGeneration { return }
        isReadingDiagnostics = false
        diagnosticsConnection?.interruptionHandler = nil
        diagnosticsConnection?.invalidationHandler = nil
        diagnosticsConnection?.invalidate()
        diagnosticsConnection = nil
    }

    private func makeConnection() -> NSXPCConnection {
        let connection = NSXPCConnection(
            machServiceName: FullMonitoringXPC.machServiceName,
            options: .privileged
        )
        connection.remoteObjectInterface = NSXPCInterface(with: FullMonitoringXPCProtocol.self)
        connection.interruptionHandler = { [weak self] in
            self?.queue.async { self?.resetConnection() }
        }
        connection.invalidationHandler = { [weak self] in
            self?.queue.async { self?.resetConnection() }
        }
        connection.resume()
        self.connection = connection
        needsServerNamePolicySync = true
        return connection
    }

    private func consume(_ data: Data) {
        guard isRunning else { return }
        do {
            let observations = data.isEmpty
                ? []
                : try FullMonitoringXPC.decoder().decode([ConnectionObservation].self, from: data)
            if !observations.isEmpty {
                try store.append(observations)
                observationHandler(observations)
                // Data arriving is what proves the Mac is being watched, and it
                // is what opens a coverage session. Relying on a status change
                // meant a session closed by anything never reopened.
                coverageHandler()
                recoveryHandler()
            }
            // "Active" means traffic has actually come through, not that the
            // XPC service answered. An extension left behind by an update
            // answers every drain with zero observations, and reporting that as
            // active told the user monitoring was running while nothing at all
            // was being recorded.
            if !reportedActive, !observations.isEmpty {
                reportedActive = true
                statusHandler(.fullActive)
            } else if !reportedActive, !reportedStarting {
                reportedStarting = true
                statusHandler(.fullStarting)
            }
        } catch {
            errorHandler(error)
        }
    }

    private func resetConnection() {
        connection?.invalidationHandler = nil
        connection?.interruptionHandler = nil
        connection?.invalidate()
        connection = nil
        reportedActive = false
        reportedStarting = false
    }
}
