import EgressViewAgentCore
import Foundation

final class FullMonitoringCollector {
    private let store: ObservationStore
    private let observationHandler: ([ConnectionObservation]) -> Void
    private let statusHandler: (AgentMonitoringStatus) -> Void
    private let errorHandler: (Error) -> Void
    private let coverageHandler: () -> Void
    private let queue = DispatchQueue(label: "com.egressview.agent.full-monitoring")
    private var connection: NSXPCConnection?
    private var timer: DispatchSourceTimer?
    private var reportedActive = false
    private var reportedStarting = false
    private var isRunning = false

    init(
        store: ObservationStore,
        observationHandler: @escaping ([ConnectionObservation]) -> Void,
        statusHandler: @escaping (AgentMonitoringStatus) -> Void,
        errorHandler: @escaping (Error) -> Void,
        coverageHandler: @escaping () -> Void = {}
    ) {
        self.store = store
        self.observationHandler = observationHandler
        self.statusHandler = statusHandler
        self.errorHandler = errorHandler
        self.coverageHandler = coverageHandler
    }

    func start() {
        queue.async { [weak self] in self?.startOnQueue() }
    }

    func stop() {
        queue.async { [weak self] in self?.stopOnQueue() }
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
        timer?.cancel()
        timer = nil
        connection?.invalidate()
        connection = nil
        reportedActive = false
        reportedStarting = false
    }

    private func poll() {
        guard isRunning else { return }
        let connection = connection ?? makeConnection()
        guard let proxy = connection.remoteObjectProxyWithErrorHandler({ [weak self] _ in
            self?.queue.async { self?.resetConnection() }
        }) as? FullMonitoringXPCProtocol else {
            resetConnection()
            return
        }
        proxy.drainObservations { [weak self] data in
            self?.queue.async { self?.consume(data) }
        }
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
