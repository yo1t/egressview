import Foundation

public struct ObservationDeduplicator {
    private var previous: [String: ConnectionObservation] = [:]
    private let retentionInterval: TimeInterval

    public init(retentionInterval: TimeInterval = 30) {
        self.retentionInterval = retentionInterval
    }

    public mutating func merge(
        _ snapshot: [ConnectionObservation],
        observedAt: Date = Date()
    ) -> [ConnectionObservation] {
        var current: [String: ConnectionObservation] = [:]
        for observation in snapshot {
            let key = observation.stableKey
            current[key] = previous[key]?.merging(observation) ?? observation
        }

        previous = previous.filter {
            observedAt.timeIntervalSince($0.value.lastObservedAt) <= retentionInterval
        }
        for (key, observation) in current {
            previous[key] = observation
        }
        return current.values.sorted { $0.stableKey < $1.stableKey }
    }
}
