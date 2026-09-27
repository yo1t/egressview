import Foundation

/// The connection log read as things that happened, in the order they
/// happened: a connection opened, a connection ended (P3-107 stage 3).
///
/// Built from the connection rows, not from a record of its own. This agent is
/// told about a connection twice -- when it opens and when it closes -- and
/// both reports end up in the one row, which keeps when it was first seen, when
/// it was last seen and, once it has closed, how much it carried. Those are the
/// two events, so nothing more needs storing to show them.
///
/// Not called "per observation", which is what the Windows log offers: there a
/// long connection is observed again and again, and here it is not. Two views
/// under one name that show different things would be read as the same thing.
public enum ConnectionLogEvent: Equatable, Sendable {
    case opened
    case ended

    /// One thing that happened to one connection.
    public struct Entry: Equatable, Sendable {
        public let kind: ConnectionLogEvent
        public let at: Date
        public let observation: ConnectionObservation
        /// Where the connection is in the list the events were built from, so
        /// a caller can find its own row for it.
        public let index: Int
    }

    /// The events these connections produced since `since`, newest first, at
    /// most `limit`.
    ///
    /// A connection whose end has not been reported has only its opening: the
    /// agent has not seen it end, and inventing an end would claim it had.
    /// Only the Network Extension reports ends at all, so only its rows can
    /// have one. An opening before `since` is left out: the period's log does
    /// not list what happened before the period, even for a connection that
    /// ended inside it.
    public static func events(
        from observations: [ConnectionObservation], since: Date, limit: Int
    ) -> [Entry] {
        var entries: [Entry] = []
        entries.reserveCapacity(observations.count * 2)
        for (index, observation) in observations.enumerated() {
            if observation.firstObservedAt >= since {
                entries.append(Entry(kind: .opened, at: observation.firstObservedAt, observation: observation, index: index))
            }
            if observation.collector == .networkExtension,
               !ConnectionLogActivity.isOpen(observation),
               observation.lastObservedAt >= since {
                entries.append(Entry(kind: .ended, at: observation.lastObservedAt, observation: observation, index: index))
            }
        }
        // Stable for equal times: an opening and ending in the same instant
        // read ended-above-opened, which is the order they happened in when
        // the list runs newest first.
        let ordered = entries.enumerated().sorted { lhs, rhs in
            if lhs.element.at != rhs.element.at { return lhs.element.at > rhs.element.at }
            return lhs.offset > rhs.offset
        }
        return ordered.prefix(max(0, limit)).map(\.element)
    }
}
