import Foundation

/// The flows that closed a moment ago, so a second close report for the same
/// flow can be recognised and set aside.
///
/// macOS sends some flows' close report twice, under the same flow ID and
/// within a millisecond. Measured on 2026-10-03: of 91 TCP flows over three
/// minutes, 59 closed twice -- every one of them a flow whose report said zero
/// bytes both ways. The first close took the flow's packet counts; the second
/// found none left, carried the report's zero, and overwrote the first in the
/// local store, which updates a flow's row in place. A flow that sent 148
/// bytes was kept as having sent nothing.
///
/// A second close carries nothing the first did not, so it is not recorded
/// again. The memory is short and bounded: a duplicate arrives at once, and a
/// flow ID is not reused.
public struct RecentlyClosedFlows: Sendable {
    public static let defaultCapacity = 4_096
    public static let defaultLifetime: TimeInterval = 60

    private let capacity: Int
    private let lifetime: TimeInterval
    private var closedAt: [UUID: TimeInterval] = [:]
    private var order: [UUID] = []
    private var head = 0

    public init(
        capacity: Int = RecentlyClosedFlows.defaultCapacity,
        lifetime: TimeInterval = RecentlyClosedFlows.defaultLifetime
    ) {
        self.capacity = max(1, capacity)
        self.lifetime = lifetime
    }

    /// Records that `flowID` closed at `time`. Returns false when it had
    /// already closed within the lifetime -- the report is a duplicate.
    public mutating func recordClose(_ flowID: UUID, at time: TimeInterval) -> Bool {
        expire(before: time - lifetime)
        if closedAt[flowID] != nil { return false }
        closedAt[flowID] = time
        order.append(flowID)
        while closedAt.count > capacity { dropOldest() }
        return true
    }

    public var count: Int { closedAt.count }

    private mutating func expire(before cutoff: TimeInterval) {
        while head < order.count, let time = closedAt[order[head]], time < cutoff {
            dropOldest()
        }
    }

    private mutating func dropOldest() {
        guard head < order.count else { return }
        closedAt.removeValue(forKey: order[head])
        head += 1
        // Reclaim the consumed prefix once it outweighs what is left.
        if head > 1_024, head * 2 > order.count {
            order.removeFirst(head)
            head = 0
        }
    }
}
