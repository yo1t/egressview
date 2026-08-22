import EgressViewAgentCore
import EgressViewNetworkExtension

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
    override var readsServerName: Bool {
        FullMonitoringXPCServer.shared.isServerNameReadingEnabled
    }

    override func didObserve(_ observation: ConnectionObservation) {
        FullMonitoringXPCServer.shared.enqueue(observation)
    }

    override func didObserveQUICFeasibility(_ event: QUICFeasibilityEvent) {
        FullMonitoringXPCServer.shared.record(event)
    }
}
