import EgressViewAgentCore
import Foundation

/// Which kind of report the system delivered for a flow.
///
/// Kept as a plain value so the decision logic can be tested without
/// constructing `NEFilterReport`, which has no public initialiser.
public enum FlowReportKind: Equatable, Sendable {
    /// Final counts for a flow that has ended.
    case flowClosed
    /// Periodic counts for a flow that is still open.
    case statistics
    case other
}

/// Remembers when each open flow started, so that the byte counts delivered at
/// close time can be attached to the flow's real start rather than to the
/// moment it ended.
///
/// The Network Extension path does not go through `ObservationDeduplicator`,
/// and the delivery queue replaces same-key entries rather than merging them.
/// Without this, a closed-flow observation would report the close time as the
/// flow's start.
public struct OpenFlowRegistry: Sendable {
    private struct Entry {
        var metadata: SocketFlowMetadata
        let startedAt: Date
        var hasReportedOpening = false
    }

    /// Flows that never produce a close report would otherwise accumulate for
    /// as long as monitoring runs. The oldest are dropped first: their byte
    /// counts are still reported, only the original start time is lost.
    public static let defaultCapacity = 10_000

    private var entries: [UUID: Entry] = [:]
    private var insertionOrder: [UUID] = []
    private let capacity: Int

    public init(capacity: Int = OpenFlowRegistry.defaultCapacity) {
        self.capacity = max(1, capacity)
    }

    public var count: Int { entries.count }

    public mutating func register(
        flowID: UUID,
        metadata: SocketFlowMetadata,
        startedAt: Date
    ) {
        if entries[flowID] == nil {
            insertionOrder.append(flowID)
        }
        entries[flowID] = Entry(metadata: metadata, startedAt: startedAt)
        while insertionOrder.count > capacity {
            let oldest = insertionOrder.removeFirst()
            entries.removeValue(forKey: oldest)
        }
    }

    /// Records the name the connection asked for, read from its TLS
    /// ClientHello.
    ///
    /// Only fills a gap: macOS supplies the name for flows that went through
    /// its own networking, and that one is authoritative. This covers the
    /// applications that bring their own stack -- about half the connections on
    /// a real machine, including every browser measured.
    public mutating func noteServerName(_ name: String, flowID: UUID) {
        guard var entry = entries[flowID] else { return }
        guard entry.metadata.remoteHostname?.isEmpty ?? true else { return }
        entry.metadata = SocketFlowMetadata(
            networkProtocol: entry.metadata.networkProtocol,
            localAddress: entry.metadata.localAddress,
            localPort: entry.metadata.localPort,
            remoteAddress: entry.metadata.remoteAddress,
            remotePort: entry.metadata.remotePort,
            processID: entry.metadata.processID,
            processName: entry.metadata.processName,
            bundleID: entry.metadata.bundleID,
            remoteHostname: name
        )
        entries[flowID] = entry
    }

    /// Emits the opening observation once, after the first outbound bytes have
    /// given the TLS parser its chance to attach SNI. The closing report later
    /// carries the same flow ID and updates this row with final byte counts.
    public mutating func openingObservation(
        flowID: UUID,
        observedAt: Date
    ) -> ConnectionObservation? {
        guard var entry = entries[flowID], !entry.hasReportedOpening else { return nil }
        entry.hasReportedOpening = true
        entries[flowID] = entry
        return observation(
            flowID: flowID,
            metadata: entry.metadata,
            firstObservedAt: entry.startedAt,
            lastObservedAt: observedAt,
            bytesIn: nil,
            bytesOut: nil
        )
    }

    /// Builds the observation for a report, or returns nil when the report
    /// carries nothing worth recording.
    ///
    /// **Only `flowClosed` produces byte counts.** A `statistics` report is a
    /// running total for a flow that is still open, and whether its counters
    /// are cumulative or per-interval has not been measured on a real machine.
    /// Recording an unmeasured value as if it were final would put a number in
    /// front of the user that nobody has checked.
    public mutating func complete(
        flowID: UUID,
        kind: FlowReportKind,
        bytesIn: UInt64,
        bytesOut: UInt64,
        metadata: SocketFlowMetadata?,
        reportedAt: Date
    ) -> ConnectionObservation? {
        guard kind == .flowClosed else { return nil }

        let entry = entries.removeValue(forKey: flowID)
        if entry != nil, let index = insertionOrder.firstIndex(of: flowID) {
            insertionOrder.remove(at: index)
        }
        // The report's own metadata is the fallback for a flow this registry
        // never saw, or whose entry was evicted.
        guard let resolved = entry?.metadata ?? metadata else { return nil }

        return observation(
            flowID: flowID,
            metadata: resolved,
            firstObservedAt: entry?.startedAt ?? reportedAt,
            lastObservedAt: reportedAt,
            bytesIn: bytesIn,
            bytesOut: bytesOut
        )
    }

    private func observation(
        flowID: UUID,
        metadata: SocketFlowMetadata,
        firstObservedAt: Date,
        lastObservedAt: Date,
        bytesIn: UInt64?,
        bytesOut: UInt64?
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: metadata.networkProtocol,
            localAddress: metadata.localAddress,
            localPort: metadata.localPort,
            remoteAddress: metadata.remoteAddress,
            remotePort: metadata.remotePort,
            processID: metadata.processID,
            processName: metadata.processName,
            bundleID: metadata.bundleID,
            firstObservedAt: firstObservedAt,
            lastObservedAt: lastObservedAt,
            bytesIn: bytesIn,
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: metadata.remoteHostname,
            flowID: flowID
        )
    }

    /// Drops entries for flows that have stayed open longer than the agent will
    /// ever wait for a close report.
    public mutating func evictEntries(startedBefore cutoff: Date) {
        let stale = insertionOrder.filter { entries[$0].map { $0.startedAt < cutoff } ?? true }
        for flowID in stale {
            entries.removeValue(forKey: flowID)
        }
        insertionOrder.removeAll { stale.contains($0) }
    }
}
