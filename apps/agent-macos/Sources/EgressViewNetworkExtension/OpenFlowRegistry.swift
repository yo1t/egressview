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
        let metadata: SocketFlowMetadata
        let startedAt: Date
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

        return ConnectionObservation(
            networkProtocol: resolved.networkProtocol,
            localAddress: resolved.localAddress,
            localPort: resolved.localPort,
            remoteAddress: resolved.remoteAddress,
            remotePort: resolved.remotePort,
            processID: resolved.processID,
            processName: resolved.processName,
            bundleID: resolved.bundleID,
            firstObservedAt: entry?.startedAt ?? reportedAt,
            lastObservedAt: reportedAt,
            bytesIn: bytesIn,
            bytesOut: bytesOut,
            collector: .networkExtension,
            confidence: .exact,
            remoteHostname: resolved.remoteHostname
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
