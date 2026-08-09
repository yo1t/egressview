import EgressViewAgentCore
import NetworkExtension

public struct PassOnlyFlowPolicy: Sendable {
    public init() {}

    public var readsPayload: Bool { false }
    public var decision: FlowDecision { .allowAndReportMetadata }
}

public enum FlowDecision: Equatable, Sendable {
    case allowAndReportMetadata
}

open class PassOnlyFilterDataProvider: NEFilterDataProvider {
    private let policy = PassOnlyFlowPolicy()
    private let adapter = NetworkExtensionFlowAdapter()
    private let mapper = NetworkFlowObservationMapper()

    public override init() {
        super.init()
    }

    open override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        if let socketFlow = flow as? NEFilterSocketFlow,
           let metadata = adapter.metadata(from: socketFlow) {
            didObserve(mapper.map(metadata))
        }
        switch policy.decision {
        case .allowAndReportMetadata:
            let verdict = NEFilterNewFlowVerdict.allow()
            verdict.shouldReport = true
            return verdict
        }
    }

    open func didObserve(_ observation: ConnectionObservation) {
        // A later phase will connect this boundary to local storage or opt-in Hub delivery.
    }
}
