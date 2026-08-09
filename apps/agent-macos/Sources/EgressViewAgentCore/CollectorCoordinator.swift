import Foundation

public enum MonitoringMode: String, Codable, Sendable {
    case full
    case lightweight
    case paused
}

public enum CollectorFailure: Error, Equatable {
    case approvalRequired
    case unavailable(String)
}

public enum MonitoringState: Equatable {
    case inactive
    case activating(MonitoringMode)
    case approvalRequired
    case active(MonitoringMode)
    case failed(String)
    case deactivating(MonitoringMode)
}

public final class CollectorCoordinator {
    public private(set) var selectedMode: MonitoringMode = .paused
    public private(set) var state: MonitoringState = .inactive

    private let fullFactory: () -> ObservationCollector
    private let lightweightFactory: () -> ObservationCollector
    private var activeCollector: ObservationCollector?

    public init(
        fullFactory: @escaping () -> ObservationCollector,
        lightweightFactory: @escaping () -> ObservationCollector
    ) {
        self.fullFactory = fullFactory
        self.lightweightFactory = lightweightFactory
    }

    @discardableResult
    public func switchMode(to mode: MonitoringMode) -> MonitoringState {
        if selectedMode == mode, activeCollector?.isRunning == true {
            return state
        }

        if let collector = activeCollector {
            state = .deactivating(selectedMode)
            collector.stop()
            activeCollector = nil
        }

        selectedMode = mode
        guard mode != .paused else {
            state = .inactive
            return state
        }

        state = .activating(mode)
        let collector = mode == .full ? fullFactory() : lightweightFactory()
        do {
            try collector.start()
            activeCollector = collector
            state = .active(mode)
        } catch CollectorFailure.approvalRequired {
            state = .approvalRequired
        } catch {
            state = .failed(String(describing: error))
        }
        return state
    }
}
