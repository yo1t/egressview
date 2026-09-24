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
        let currentKeys = Set(observations.map(\.deliveryIdentity))
        lastPersistedAt = lastPersistedAt.filter { currentKeys.contains($0.key) }

        return observations.filter { observation in
            // By flow when there is one. Keyed by the tuple, a second
            // connection from the same process to the same server within the
            // refresh interval looked like a repeat of the first and was
            // never queued at all (P3-164).
            let key = observation.deliveryIdentity
            guard let previous = lastPersistedAt[key],
                  observedAt.timeIntervalSince(previous) < refreshInterval else {
                lastPersistedAt[key] = observedAt
                return true
            }
            return false
        }
    }
}
