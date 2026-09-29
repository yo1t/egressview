import Foundation

/// The Extension's side of handing observations to the app.
///
/// A batch leaves the queue only when the app says it has stored it. Until
/// then it is handed over again, under the same number, on every request.
/// Before this, the Extension emptied its queue as it replied, so a reply that
/// never arrived -- a timed-out request, a connection torn down mid-flight --
/// took every observation in it with it, and nothing recorded that they had
/// ever existed (P3-181).
public struct ObservationHandoff: Sendable {
    public struct Batch: Equatable, Sendable {
        public let id: Int64
        public let observations: [ConnectionObservation]
    }

    public let capacity: Int
    public private(set) var pending: [ConnectionObservation] = []
    public private(set) var inFlight: Batch?
    private var nextID: Int64

    /// Numbers start somewhere random, so a restarted Extension cannot hand
    /// over a new batch under the number the app last acknowledged -- which
    /// the app would take for a batch it already has.
    public init(capacity: Int = 10_000, firstID: Int64 = Int64.random(in: 1...(Int64.max / 2))) {
        self.capacity = max(1, capacity)
        self.nextID = max(1, firstID)
    }

    /// Adds one observation. Returns true when the oldest waiting one had to
    /// go to make room.
    @discardableResult
    public mutating func enqueue(_ observation: ConnectionObservation) -> Bool {
        let full = pending.count >= capacity
        if full { pending.removeFirst() }
        pending.append(observation)
        return full
    }

    /// Everything waiting, removed as it is returned: the old, unacknowledged
    /// way. A batch in flight is not touched.
    public mutating func takePendingWithoutAcknowledgement() -> [ConnectionObservation] {
        defer { pending.removeAll(keepingCapacity: true) }
        return pending
    }

    /// What to hand over for a request that acknowledges `acknowledgement`.
    ///
    /// The batch in flight is released if that is its number, and handed over
    /// again if not. Only once nothing is in flight does a new batch form.
    public mutating func take(acknowledging acknowledgement: Int64) -> (batch: Batch?, isResend: Bool) {
        if let batch = inFlight {
            guard batch.id == acknowledgement else { return (batch, true) }
            inFlight = nil
        }
        guard !pending.isEmpty else { return (nil, false) }
        let batch = Batch(id: nextID, observations: pending)
        nextID = nextID == .max ? 1 : nextID + 1
        pending.removeAll(keepingCapacity: true)
        inFlight = batch
        return (batch, false)
    }
}

/// The app's side: which batch it last stored, and whether one it is handed
/// is new.
public struct ObservationHandoffReceiver: Sendable {
    public enum Decision: Equatable, Sendable {
        case store
        /// The Extension handed over a batch the app has already stored,
        /// because the acknowledgement had not reached it yet.
        case alreadyStored
    }

    /// Sent with every request. Zero means nothing stored yet.
    public private(set) var acknowledgement: Int64 = 0
    public let maximumAttempts: Int
    private var failingBatch: Int64?
    private var failures = 0

    public init(maximumAttempts: Int = 3) {
        self.maximumAttempts = max(1, maximumAttempts)
    }

    public func decide(_ batchID: Int64) -> Decision {
        batchID == acknowledgement ? .alreadyStored : .store
    }

    public mutating func stored(_ batchID: Int64) {
        acknowledgement = batchID
        failingBatch = nil
        failures = 0
    }

    /// Records a failure to store. Returns true when this batch has now
    /// failed often enough to be let go: acknowledged so the Extension moves
    /// on, rather than handing the same undecodable batch over for ever while
    /// everything behind it waits.
    public mutating func failed(_ batchID: Int64) -> Bool {
        if failingBatch != batchID {
            failingBatch = batchID
            failures = 0
        }
        failures += 1
        guard failures >= maximumAttempts else { return false }
        stored(batchID)
        return true
    }
}
