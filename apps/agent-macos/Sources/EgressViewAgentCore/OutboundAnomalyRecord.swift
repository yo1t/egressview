import Foundation

/// One application or destination and what it sent in an anomalous window.
public struct OutboundContributor: Codable, Equatable, Sendable {
    public let name: String
    public let bytesOut: UInt64

    public init(name: String, bytesOut: UInt64) {
        self.name = name
        self.bytesOut = bytesOut
    }
}

/// What was kept about a window the detector flagged, so it can be explained
/// later rather than only counted.
///
/// The breakdown is written when the anomaly is found, because that is the
/// only time it can be: the window's individual connections age out of the
/// store, and the usual level it was compared with is not kept anywhere else.
/// Windows flagged before this was recorded have no breakdown, and say so.
public struct OutboundAnomalyRecord: Codable, Equatable, Sendable, Identifiable {
    public let kind: OutboundAnomalyKind
    public let windowStart: Date
    public let windowLength: TimeInterval
    public let bytesOut: UInt64
    public let applicationCount: Int
    public let destinationCount: Int
    public let breakdown: Breakdown?

    public var id: Date { windowStart }
    public var windowEnd: Date { windowStart.addingTimeInterval(windowLength) }

    public struct Breakdown: Codable, Equatable, Sendable {
        /// The median of the windows it was compared with.
        public let usualBytesOut: UInt64
        public let applications: [OutboundContributor]
        public let destinations: [OutboundContributor]
        /// Destinations that sent anything, of which `destinations` is the top.
        public let sendingDestinationCount: Int

        public init(
            usualBytesOut: UInt64, applications: [OutboundContributor],
            destinations: [OutboundContributor], sendingDestinationCount: Int
        ) {
            self.usualBytesOut = usualBytesOut
            self.applications = applications
            self.destinations = destinations
            self.sendingDestinationCount = sendingDestinationCount
        }
    }

    public init(
        kind: OutboundAnomalyKind, windowStart: Date, windowLength: TimeInterval = 900,
        bytesOut: UInt64, applicationCount: Int, destinationCount: Int,
        breakdown: Breakdown?
    ) {
        self.kind = kind
        self.windowStart = windowStart
        self.windowLength = windowLength
        self.bytesOut = bytesOut
        self.applicationCount = applicationCount
        self.destinationCount = destinationCount
        self.breakdown = breakdown
    }
}
