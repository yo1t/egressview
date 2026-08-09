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

public final class PassOnlyFilterDataProvider: NEFilterDataProvider {
    private let policy = PassOnlyFlowPolicy()

    public override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        switch policy.decision {
        case .allowAndReportMetadata:
            let verdict = NEFilterNewFlowVerdict.allow()
            verdict.shouldReport = true
            return verdict
        }
    }
}
