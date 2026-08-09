import Foundation

public protocol ObservationCollector: AnyObject {
    var kind: CollectorKind { get }
    var isRunning: Bool { get }
    func start() throws
    func stop()
}

public final class LightweightCollector: ObservationCollector {
    public let kind: CollectorKind = .libproc
    public private(set) var isRunning = false

    private let provider: SocketSnapshotProviding
    private let interval: TimeInterval
    private let queue: DispatchQueue
    private let handler: ([ConnectionObservation]) -> Void
    private var timer: DispatchSourceTimer?
    private var deduplicator: ObservationDeduplicator

    public init(
        provider: SocketSnapshotProviding = LibProcSocketSnapshotProvider(),
        interval: TimeInterval = 2,
        queue: DispatchQueue = DispatchQueue(label: "com.egressview.agent.libproc"),
        handler: @escaping ([ConnectionObservation]) -> Void
    ) {
        self.provider = provider
        self.interval = max(0.1, interval)
        self.queue = queue
        self.handler = handler
        self.deduplicator = ObservationDeduplicator(retentionInterval: max(10, interval * 3))
    }

    public func start() throws {
        guard !isRunning else { return }
        _ = try pollOnce()

        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self] in
            _ = try? self?.pollOnce()
        }
        self.timer = timer
        isRunning = true
        timer.resume()
    }

    public func stop() {
        guard isRunning else { return }
        timer?.setEventHandler {}
        timer?.cancel()
        timer = nil
        isRunning = false
    }

    @discardableResult
    public func pollOnce(at date: Date = Date()) throws -> [ConnectionObservation] {
        let observations = deduplicator.merge(try provider.snapshot(at: date), observedAt: date)
        handler(observations)
        return observations
    }

    deinit {
        stop()
    }
}
