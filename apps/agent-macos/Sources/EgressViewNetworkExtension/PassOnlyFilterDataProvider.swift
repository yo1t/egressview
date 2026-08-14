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
    private var openFlows = OpenFlowRegistry()
    private let lock = NSLock()

    public override init() {
        super.init()
    }

    open override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        if let socketFlow = flow as? NEFilterSocketFlow,
           let metadata = adapter.metadata(from: socketFlow) {
            let observedAt = Date()
            lock.withLock {
                openFlows.register(
                    flowID: socketFlow.identifier,
                    metadata: metadata,
                    startedAt: observedAt
                )
            }
            didObserve(mapper.map(metadata, observedAt: observedAt))
        }
        switch policy.decision {
        case .allowAndReportMetadata:
            let verdict = NEFilterNewFlowVerdict.allow()
            // Asking for reports is what makes the closing byte counts arrive.
            // The verdict stays `.allow()`, so the flow's data never enters this
            // process: the system counts the bytes, we only receive the totals.
            verdict.shouldReport = true
            return verdict
        }
    }

    /// Receives the counts the system kept for a flow.
    ///
    /// Statistics reports are deliberately ignored for now. Whether their
    /// counters are cumulative or per-interval is not documented and has not
    /// been measured here, and a byte count nobody has verified is worse than
    /// no byte count -- the user cannot tell a wrong number from a right one.
    open override func handle(_ report: NEFilterReport) {
        guard let socketFlow = report.flow as? NEFilterSocketFlow else { return }
        let observation = lock.withLock {
            openFlows.complete(
                flowID: socketFlow.identifier,
                kind: FlowReportKind(report.event),
                bytesIn: UInt64(max(0, report.bytesInboundCount)),
                bytesOut: UInt64(max(0, report.bytesOutboundCount)),
                metadata: adapter.metadata(from: socketFlow),
                reportedAt: Date()
            )
        }
        if let observation {
            didObserve(observation)
        }
    }

    open func didObserve(_ observation: ConnectionObservation) {
        // The host extension overrides this boundary to persist metadata locally.
    }
}

extension FlowReportKind {
    init(_ event: NEFilterReport.Event) {
        switch event {
        case .flowClosed:
            self = .flowClosed
        case .statistics:
            self = .statistics
        default:
            self = .other
        }
    }
}
