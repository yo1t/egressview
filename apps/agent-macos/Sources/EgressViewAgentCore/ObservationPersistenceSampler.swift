import Foundation

public struct ObservationPersistenceSampler: Sendable {
    private let refreshInterval: TimeInterval
    private var lastPersistedAt: [String: Date] = [:]

    public init(refreshInterval: TimeInterval = 15 * 60) {
        self.refreshInterval = max(1, refreshInterval)
    }

    public mutating func observationsToPersist(
        _ observations: [ConnectionObservation],
        observedAt: Date = Date()
    ) -> [ConnectionObservation] {
        let currentKeys = Set(observations.map(\.stableKey))
        lastPersistedAt = lastPersistedAt.filter { currentKeys.contains($0.key) }

        return observations.filter { observation in
            let key = observation.stableKey
            guard let previous = lastPersistedAt[key],
                  observedAt.timeIntervalSince(previous) < refreshInterval else {
                lastPersistedAt[key] = observedAt
                return true
            }
            return false
        }
    }
}
