import EgressViewAgentCore
import EgressViewNetworkExtension

final class EgressViewFilterDataProvider: PassOnlyFilterDataProvider {
    override func didObserve(_ observation: ConnectionObservation) {
        FullMonitoringXPCServer.shared.enqueue(observation)
    }
}
