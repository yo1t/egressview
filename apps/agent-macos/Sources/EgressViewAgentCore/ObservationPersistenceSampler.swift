import Foundation

public struct ObservationPersistenceSampler: Sendable {
    private struct Sent {
        let at: Date
        let hadByteCounts: Bool
    }

    private let refreshInterval: TimeInterval
    private var lastPersisted: [String: Sent] = [:]

    public init(refreshInterval: TimeInterval = 15 * 60) {
        self.refreshInterval = max(1, refreshInterval)
    }

    public mutating func observationsToPersist(
        _ observations: [ConnectionObservation],
        observedAt: Date = Date()
    ) -> [ConnectionObservation] {
        let currentKeys = Set(observations.map(\.deliveryIdentity))
        lastPersisted = lastPersisted.filter { currentKeys.contains($0.key) }

        return observations.filter { observation in
            // By flow when there is one. Keyed by the tuple, a second
            // connection from the same process to the same server within the
            // refresh interval looked like a repeat of the first and was
            // never queued at all (P3-164).
            let key = observation.deliveryIdentity
            let hasByteCounts = observation.bytesIn != nil || observation.bytesOut != nil
            // A report is a repeat only if it says nothing the last one did
            // not. The closing report of a Network Extension flow is the only
            // one that carries byte counts, and it usually arrives within a
            // second of the opening one. Keyed by the tuple it slipped through
            // by accident -- the opening report often has local port 0 and the
            // closing one the real port -- and keying by flow closed that gap:
            // on the production Hub the share of this Mac's rows with byte
            // counts fell from 50% to 15% at the same hours of the day after
            // 0.5.87.
            if let previous = lastPersisted[key],
               observedAt.timeIntervalSince(previous.at) < refreshInterval,
               !(hasByteCounts && !previous.hadByteCounts) {
                return false
            }
            lastPersisted[key] = Sent(
                at: observedAt,
                hadByteCounts: hasByteCounts || (lastPersisted[key]?.hadByteCounts ?? false)
            )
            return true
        }
    }
}
