import Foundation

/// Avoids regrouping a long raw-history window on every screen tick.
///
/// Threat feeds are refreshed hourly and a seven-day result does not become
/// meaningfully safer by sorting the same history every fifteen seconds. Short
/// windows remain live; week and month windows reuse candidates briefly.
public final class ThreatCandidateRefreshCache: @unchecked Sendable {
    private struct Entry {
        let scale: TimeScale
        let expiresAt: Date
        let candidates: [ThreatCandidate]
    }

    private let lock = NSLock()
    private let longWindowTTL: TimeInterval
    private var entry: Entry?
    private var generation: UInt64 = 0

    public init(longWindowTTL: TimeInterval = 5 * 60) {
        self.longWindowTTL = max(0, longWindowTTL)
    }

    public func candidates(
        scale: TimeScale,
        now: Date = Date(),
        load: () throws -> [ThreatCandidate]
    ) throws -> [ThreatCandidate] {
        guard scale == .week || scale == .month, longWindowTTL > 0 else {
            return try load()
        }

        let snapshot = lock.withLock { () -> (Entry?, UInt64) in
            (entry, generation)
        }
        if let cached = snapshot.0,
           cached.scale == scale,
           cached.expiresAt > now {
            return cached.candidates
        }

        let loaded = try load()
        lock.withLock {
            // An explicit invalidation while the query was running wins. This
            // prevents an old period from being restored after a tab change.
            guard generation == snapshot.1 else { return }
            entry = Entry(
                scale: scale,
                expiresAt: now.addingTimeInterval(longWindowTTL),
                candidates: loaded
            )
        }
        return loaded
    }

    public func invalidate() {
        lock.withLock {
            generation &+= 1
            entry = nil
        }
    }
}
