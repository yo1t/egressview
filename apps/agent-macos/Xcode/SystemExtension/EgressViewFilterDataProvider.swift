import EgressViewAgentCore
import EgressViewNetworkExtension

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
    override var readsServerName: Bool {
        FullMonitoringXPCServer.shared.isServerNameReadingEnabled
    }

    override func didObserve(_ observation: ConnectionObservation) {
        FullMonitoringXPCServer.shared.enqueue(observation)
    }

    override func didRecordFlowCapture(_ stage: FlowCaptureDiagnostics.Stage) {
        FullMonitoringXPCServer.shared.recordFlowCapture(stage)
    }

    override func didObserveQUICFeasibility(_ event: QUICFeasibilityEvent) {
        FullMonitoringXPCServer.shared.record(event)
    }
}
