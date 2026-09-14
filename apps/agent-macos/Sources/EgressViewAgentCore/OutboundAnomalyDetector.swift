import Foundation

/// A completed local observation window used for behavioural comparison.
///
/// Byte counters are only available when a flow reports its final statistics.
/// `byteCoverage` makes that limitation explicit so incomplete windows never
/// become either an alert or a misleading baseline.
public struct OutboundTrafficWindow: Equatable, Sendable {
    public let startedAt: Date
    public let bytesOut: UInt64
    public let observationCount: Int
    public let observationsWithBytes: Int
    public let applicationCount: Int
    public let destinationCount: Int
    public let largestApplicationBytesOut: UInt64

    public var byteCoverage: Double {
        guard observationCount > 0 else { return 0 }
        return Double(observationsWithBytes) / Double(observationCount)
    }

    public init(
        startedAt: Date,
        bytesOut: UInt64,
        observationCount: Int,
        observationsWithBytes: Int,
        applicationCount: Int,
        destinationCount: Int,
        largestApplicationBytesOut: UInt64
    ) {
        self.startedAt = startedAt
        self.bytesOut = bytesOut
        self.observationCount = observationCount
        self.observationsWithBytes = observationsWithBytes
        self.applicationCount = applicationCount
        self.destinationCount = destinationCount
        self.largestApplicationBytesOut = largestApplicationBytesOut
    }
}

public enum OutboundAnomalyKind: String, Equatable, Sendable {
    case largeTransfer
    case distributedTransfer
}

public struct OutboundAnomalyFinding: Equatable, Sendable {
    public let kind: OutboundAnomalyKind
    public let window: OutboundTrafficWindow
    public let baselineMedianBytesOut: UInt64
    public let alertThresholdBytesOut: UInt64
}

/// Finds large outbound changes without claiming to identify malware.
///
/// Median and median absolute deviation resist one-off backups becoming the
/// new normal. The absolute and ratio floors also prevent a quiet baseline
/// from turning a small upload into an alarm.
public struct OutboundAnomalyDetector: Sendable {
    public struct Configuration: Equatable, Sendable {
        public var minimumBaselineWindows = 96
        public var minimumObservations = 10
        public var minimumByteCoverage = 0.8
        public var absoluteBytesFloor: UInt64 = 100 * 1_024 * 1_024
        public var minimumIncreaseBytes: UInt64 = 16 * 1_024 * 1_024
        public var medianMultiplier = 3.0
        public var madMultiplier = 6.0
        public var distributedMinimumApplications = 3
        public var distributedMinimumDestinations = 12
        public var distributedMaximumLargestAppShare = 0.6

        public init() {}
    }

    public let configuration: Configuration

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
    }

    public func evaluate(
        current: OutboundTrafficWindow,
        baseline: [OutboundTrafficWindow]
    ) -> OutboundAnomalyFinding? {
        guard current.observationCount >= configuration.minimumObservations,
              current.byteCoverage >= configuration.minimumByteCoverage else { return nil }

        let usable = baseline.filter {
            $0.observationCount >= configuration.minimumObservations
                && $0.byteCoverage >= configuration.minimumByteCoverage
        }
        guard usable.count >= configuration.minimumBaselineWindows else { return nil }

        let values = usable.map(\.bytesOut)
        let median = Self.median(values)
        let deviations = values.map { $0 >= median ? $0 - median : median - $0 }
        let mad = Self.median(deviations)
        let ratioThreshold = Self.scaled(median, by: configuration.medianMultiplier)
        let deviation = max(
            configuration.minimumIncreaseBytes,
            Self.scaled(mad, by: configuration.madMultiplier)
        )
        let deviationThreshold = median.addingReportingOverflow(deviation)
        let threshold = max(
            configuration.absoluteBytesFloor,
            ratioThreshold,
            deviationThreshold.overflow ? UInt64.max : deviationThreshold.partialValue
        )
        guard current.bytesOut >= threshold else { return nil }

        let largestShare = current.bytesOut == 0
            ? 1
            : Double(current.largestApplicationBytesOut) / Double(current.bytesOut)
        let distributed = current.applicationCount >= configuration.distributedMinimumApplications
            && current.destinationCount >= configuration.distributedMinimumDestinations
            && largestShare <= configuration.distributedMaximumLargestAppShare
        return OutboundAnomalyFinding(
            kind: distributed ? .distributedTransfer : .largeTransfer,
            window: current,
            baselineMedianBytesOut: median,
            alertThresholdBytesOut: threshold
        )
    }

    private static func median(_ values: [UInt64]) -> UInt64 {
        guard !values.isEmpty else { return 0 }
        let sorted = values.sorted()
        let middle = sorted.count / 2
        guard sorted.count.isMultiple(of: 2) else { return sorted[middle] }
        let lower = sorted[middle - 1]
        let upper = sorted[middle]
        return lower + (upper - lower) / 2
    }

    private static func scaled(_ value: UInt64, by multiplier: Double) -> UInt64 {
        let result = Double(value) * multiplier
        guard result.isFinite, result < Double(UInt64.max) else { return UInt64.max }
        return UInt64(max(0, result))
    }
}
