import EgressViewAgentCore
import NetworkExtension

public struct PassOnlyFlowPolicy: Sendable {
    /// Whether the user has asked for destination names to be read from the
    /// TLS handshake. **Off unless they turn it on.**
    public let readsServerName: Bool

    public init(readsServerName: Bool = false) {
        self.readsServerName = readsServerName
    }

    /// Still false when server names are read. The opt-in path reads protocol
    /// metadata in the opening handshake, never encrypted application content.
    public var readsApplicationContent: Bool { false }

    public var decision: FlowDecision {
        readsServerName ? .allowAndReadServerName : .allowAndReportMetadata
    }
}

public enum FlowDecision: Equatable, Sendable {
    case allowAndReportMetadata
    /// Peek at the first outbound bytes, take the server name out of the TLS
    /// ClientHello if it is there, then stop looking at this flow.
    case allowAndReadServerName
}

/// Aggregate-only events used to decide whether QUIC Initial decoding is worth
/// implementing. The event intentionally cannot carry packet bytes or identity.
public enum QUICFeasibilityEvent: Equatable, Sendable {
    case udp443Flow
    case outboundCallback(
        offset: Int,
        byteCount: Int,
        classification: QUICInitialCandidate
    )
    /// What became of a QUIC Initial once its handshake bytes were gathered.
    /// Separated from the candidate count because "recognised as an Initial"
    /// and "a name came out of it" were the same number until they were not:
    /// on 2026-08-24 the first was 172 and the second was 0.
    case assembly(QUICInitial.Assembler.Outcome)
}

open class PassOnlyFilterDataProvider: NEFilterDataProvider {
    /// Read per flow, not once at startup.
    ///
    /// It used to be captured in `init()`, and the extension is created when it
    /// launches -- so turning the setting on did nothing at all until the
    /// extension happened to restart, while the settings screen said it applied
    /// to new connections. Measured: the setting was written one minute after
    /// the extension started, and not one name was read in the five minutes
    /// after that.
    private let fixedPolicy: PassOnlyFlowPolicy?
    private let preferences = ServerNamePreferences()

    open var readsServerName: Bool { preferences.isEnabled }

    private var policy: PassOnlyFlowPolicy {
        fixedPolicy ?? PassOnlyFlowPolicy(readsServerName: readsServerName)
    }
    private let adapter = NetworkExtensionFlowAdapter()
    private let mapper = NetworkFlowObservationMapper()
    private var openFlows = OpenFlowRegistry()
    /// One QUIC reassembly per flow, held only while its first flight is still
    /// arriving. Bounded in both directions: each assembler stops after a few
    /// datagrams, and the store drops the flow as soon as a name is found or
    /// the flow is allowed through.
    private var quicAssemblers = QUICInitialAssemblerStore()
    private let lock = NSLock()

    public override init() {
        fixedPolicy = nil
        super.init()
    }

    /// For tests, and for a provider that wants to state the policy outright.
    public init(policy: PassOnlyFlowPolicy) {
        fixedPolicy = policy
        super.init()
    }

    open override func handleNewFlow(_ flow: NEFilterFlow) -> NEFilterNewFlowVerdict {
        let decision = policy.decision
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
            if decision == .allowAndReportMetadata {
                didObserve(mapper.map(
                    metadata, observedAt: observedAt, flowID: socketFlow.identifier
                ))
            }
            if decision == .allowAndReadServerName,
               metadata.networkProtocol == .udp, metadata.remotePort == 443 {
                didObserveQUICFeasibility(.udp443Flow)
            }
        }
        switch decision {
        case .allowAndReportMetadata:
            let verdict = NEFilterNewFlowVerdict.allow()
            // Asking for reports is what makes the closing byte counts arrive.
            // The verdict stays `.allow()`, so the flow's data never enters this
            // process: the system counts the bytes, we only receive the totals.
            verdict.shouldReport = true
            return verdict
        case .allowAndReadServerName:
            // Outbound only, and only the opening bytes: a ClientHello is a few
            // hundred bytes and arrives first. Nothing inbound is looked at at
            // all.
            let verdict = NEFilterNewFlowVerdict.filterDataVerdict(
                withFilterInbound: false,
                peekInboundBytes: 0,
                filterOutbound: true,
                peekOutboundBytes: TLSClientHello.maximumInterestingBytes
            )
            verdict.shouldReport = true
            return verdict
        }
    }

    /// The name in the opening bytes, whichever transport put it there.
    ///
    /// Separated from `handleOutboundData` because an `NEFilterFlow` cannot be
    /// made outside the extension, and a rule about which packets get
    /// decrypted is worth testing without one.
    ///
    /// TLS is tried first: the name is in the clear there and no key is
    /// derived. QUIC is consulted only when that finds nothing, which on a
    /// udp/443 flow it always will.
    static func serverName(
        in readBytes: Data, offset: Int, quicClassification: QUICInitialCandidate?
    ) -> String? {
        if let name = TLSClientHello.serverName(in: readBytes) { return name }
        // Only the first datagram of a connection, and only a v1 Initial. A
        // later datagram is protected with keys derived from the handshake,
        // which an observer does not have; a version this does not know would
        // be decrypted with the wrong salt and reported as malformed rather
        // than left alone.
        guard offset == 0, quicClassification == .version1 else { return nil }
        return QUICInitial.serverName(inDatagram: readBytes)
    }

    open override func handleOutboundData(
        from flow: NEFilterFlow,
        readBytesStartOffset offset: Int,
        readBytes: Data
    ) -> NEFilterDataVerdict {
        guard let socketFlow = flow as? NEFilterSocketFlow else {
            return .allow()
        }
        var classification: QUICInitialCandidate?
        var isQUICCandidate = false
        if let metadata = adapter.metadata(from: socketFlow),
           metadata.networkProtocol == .udp, metadata.remotePort == 443 {
            let seen = QUICInitialProbe.classify(readBytes)
            classification = seen
            isQUICCandidate = seen == .version1 || seen == .version2
            didObserveQUICFeasibility(.outboundCallback(
                offset: offset,
                byteCount: readBytes.count,
                classification: seen
            ))
        }

        var name = TLSClientHello.serverName(in: readBytes)
        var wantsMoreDatagrams = false
        if name == nil, isQUICCandidate {
            // A ClientHello too big for one Initial arrives in two. Measured
            // 2026-08-24: 172 v1 Initial candidates on this Mac produced not
            // one name, because this returned after the first datagram and the
            // handshake stopped mid-extension.
            let outcome = lock.withLock {
                quicAssemblers.accept(datagram: readBytes, flowID: socketFlow.identifier.uuidString)
            }
            switch outcome {
            case .name(let found): name = found
            case .needsMore: wantsMoreDatagrams = true
            case .notInitial: break
            }
            didObserveQUICFeasibility(.assembly(outcome))
        }
        if let name {
            lock.withLock {
                openFlows.noteServerName(name, flowID: socketFlow.identifier)
                quicAssemblers.finish(flowID: socketFlow.identifier.uuidString)
            }
        }
        let opening = lock.withLock {
            openFlows.openingObservation(
                flowID: socketFlow.identifier,
                observedAt: Date()
            )
        }
        if let opening { didObserve(opening) }
        if wantsMoreDatagrams {
            // Pass everything seen so far and ask for the next datagram. The
            // bound lives in the assembler; this cannot wait forever, and it
            // never holds bytes back -- `passBytes` releases them all.
            return NEFilterDataVerdict(
                passBytes: readBytes.count,
                peekBytes: TLSClientHello.maximumInterestingBytes
            )
        }
        // Otherwise this flow is done being looked at: the name is found, or
        // the client is not going to say one in a form this can read.
        lock.withLock { quicAssemblers.finish(flowID: socketFlow.identifier.uuidString) }
        return .allow()
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

    open func didObserveQUICFeasibility(_ event: QUICFeasibilityEvent) {
        // The host extension overrides this with aggregate counters only.
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
