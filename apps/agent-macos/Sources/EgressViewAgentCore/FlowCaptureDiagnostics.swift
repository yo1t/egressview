import Foundation

/// Aggregate pipeline counters only. No flow identity, address, process, or payload is retained.
public struct FlowCaptureDiagnostics: Codable, Equatable, Sendable {
    public let startedAt: Date
    public private(set) var newFlows: UInt64 = 0
    public private(set) var nonSocketFlows: UInt64 = 0
    public private(set) var nonOutboundFlows: UInt64 = 0
    public private(set) var unsupportedProtocols: UInt64 = 0
    public private(set) var missingLocalEndpoints: UInt64 = 0
    public private(set) var missingRemoteEndpoints: UInt64 = 0
    public private(set) var registeredFlows: UInt64 = 0
    public private(set) var outboundCallbacks: UInt64 = 0
    public private(set) var closedReports: UInt64 = 0
    public private(set) var unregisteredClosesRecovered: UInt64 = 0
    public private(set) var unregisteredClosesUnresolved: UInt64 = 0
    public private(set) var emittedObservations: UInt64 = 0
    public private(set) var enqueuedObservations: UInt64 = 0
    public private(set) var droppedObservations: UInt64 = 0
    public private(set) var drainedObservations: UInt64 = 0
    public private(set) var encodingFailures: UInt64 = 0

    public init(startedAt: Date = Date()) {
        self.startedAt = startedAt
    }

    public enum Stage: Sendable {
        case newFlow, nonSocket, nonOutbound, unsupportedProtocol
        case missingLocalEndpoint, missingRemoteEndpoint, registeredFlow
        case outboundCallback, closedReport, unregisteredCloseRecovered, unregisteredCloseUnresolved
        case emittedObservation, enqueuedObservation
        case droppedObservation, encodingFailure
    }

    public mutating func record(_ stage: Stage) {
        switch stage {
        case .newFlow: newFlows = Self.increment(newFlows)
        case .nonSocket: nonSocketFlows = Self.increment(nonSocketFlows)
        case .nonOutbound: nonOutboundFlows = Self.increment(nonOutboundFlows)
        case .unsupportedProtocol: unsupportedProtocols = Self.increment(unsupportedProtocols)
        case .missingLocalEndpoint: missingLocalEndpoints = Self.increment(missingLocalEndpoints)
        case .missingRemoteEndpoint: missingRemoteEndpoints = Self.increment(missingRemoteEndpoints)
        case .registeredFlow: registeredFlows = Self.increment(registeredFlows)
        case .outboundCallback: outboundCallbacks = Self.increment(outboundCallbacks)
        case .closedReport: closedReports = Self.increment(closedReports)
        case .unregisteredCloseRecovered: unregisteredClosesRecovered = Self.increment(unregisteredClosesRecovered)
        case .unregisteredCloseUnresolved: unregisteredClosesUnresolved = Self.increment(unregisteredClosesUnresolved)
        case .emittedObservation: emittedObservations = Self.increment(emittedObservations)
        case .enqueuedObservation: enqueuedObservations = Self.increment(enqueuedObservations)
        case .droppedObservation: droppedObservations = Self.increment(droppedObservations)
        case .encodingFailure: encodingFailures = Self.increment(encodingFailures)
        }
    }

    public mutating func recordDrained(_ count: Int) {
        guard count > 0 else { return }
        drainedObservations = Self.add(drainedObservations, UInt64(count))
    }

    private static func increment(_ value: UInt64) -> UInt64 {
        value == .max ? value : value + 1
    }

    private static func add(_ value: UInt64, _ amount: UInt64) -> UInt64 {
        let (result, overflow) = value.addingReportingOverflow(amount)
        return overflow ? .max : result
    }
}

/// Host-side totals since its collector started, shown beside the Extension counters.
public struct FlowPersistenceDiagnostics: Equatable, Sendable {
    public let startedAt: Date
    public private(set) var receivedObservations: UInt64 = 0
    public private(set) var persistedObservations: UInt64 = 0
    public private(set) var failedBatches: UInt64 = 0
    public private(set) var completedWithoutBytes: UInt64 = 0
    public private(set) var drainTimeouts: UInt64 = 0
    public private(set) var xpcFailures: UInt64 = 0

    public init(startedAt: Date = Date()) {
        self.startedAt = startedAt
    }

    public mutating func recordReceived(_ count: Int, completedWithoutBytes: Int) {
        receivedObservations = Self.add(receivedObservations, UInt64(max(0, count)))
        self.completedWithoutBytes = Self.add(self.completedWithoutBytes, UInt64(max(0, completedWithoutBytes)))
    }

    public mutating func recordPersisted(_ count: Int) {
        persistedObservations = Self.add(persistedObservations, UInt64(max(0, count)))
    }

    public mutating func recordFailure() {
        failedBatches = Self.add(failedBatches, 1)
    }

    public mutating func recordDrainTimeout() {
        drainTimeouts = Self.add(drainTimeouts, 1)
    }

    public mutating func recordXPCFailure() {
        xpcFailures = Self.add(xpcFailures, 1)
    }

    private static func add(_ value: UInt64, _ amount: UInt64) -> UInt64 {
        let (result, overflow) = value.addingReportingOverflow(amount)
        return overflow ? .max : result
    }
}
