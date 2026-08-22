import Foundation

/// A structural classification of the first bytes offered by NetworkExtension.
/// No packet bytes, addresses or process identity leave the callback that made
/// this value.
public enum QUICInitialCandidate: String, Codable, Equatable, Sendable {
    case notQUICInitial
    case version1
    case version2
    case unsupportedVersionLongHeader
}

public enum QUICInitialProbe {
    private static let version1: UInt32 = 0x0000_0001
    private static let version2: UInt32 = 0x6b33_43cf

    /// Recognises enough of a long header to decide whether implementing an
    /// Initial decoder is useful. It deliberately does not decrypt or retain
    /// the datagram.
    public static func classify(_ data: Data) -> QUICInitialCandidate {
        guard data.count >= 7 else { return .notQUICInitial }
        let bytes = [UInt8](data.prefix(27))
        let first = bytes[0]
        guard first & 0xc0 == 0xc0 else { return .notQUICInitial }

        let version = UInt32(bytes[1]) << 24
            | UInt32(bytes[2]) << 16
            | UInt32(bytes[3]) << 8
            | UInt32(bytes[4])
        guard version != 0 else { return .notQUICInitial }

        let destinationConnectionIDLength = Int(bytes[5])
        guard destinationConnectionIDLength <= 20 else { return .notQUICInitial }
        let sourceLengthOffset = 6 + destinationConnectionIDLength
        guard sourceLengthOffset < data.count else { return .notQUICInitial }
        let sourceConnectionIDLength = Int(data[data.startIndex + sourceLengthOffset])
        guard sourceConnectionIDLength <= 20,
              sourceLengthOffset + 1 + sourceConnectionIDLength <= data.count
        else { return .notQUICInitial }

        let packetType = first & 0x30
        if version == version1, packetType == 0x00 { return .version1 }
        if version == version2, packetType == 0x10 { return .version2 }
        return .unsupportedVersionLongHeader
    }
}

/// Privacy-safe evidence for deciding whether QUIC Initial decoding is viable
/// through NEFilterDataProvider. These are process-lifetime counters only.
public struct QUICFeasibilityDiagnostics: Codable, Equatable, Sendable {
    public let startedAt: Date
    public private(set) var updatedAt: Date?
    public private(set) var udp443Flows: UInt64 = 0
    public private(set) var outboundCallbacks: UInt64 = 0
    public private(set) var zeroOffsetCallbacks: UInt64 = 0
    public private(set) var inspectedBytes: UInt64 = 0
    public private(set) var version1InitialCandidates: UInt64 = 0
    public private(set) var version2InitialCandidates: UInt64 = 0
    public private(set) var unsupportedVersionLongHeaders: UInt64 = 0

    public init(startedAt: Date = Date()) {
        self.startedAt = startedAt
    }

    public var initialCandidates: UInt64 {
        Self.addingWithoutOverflow(version1InitialCandidates, version2InitialCandidates)
    }

    public mutating func recordUDP443Flow(at date: Date = Date()) {
        udp443Flows = Self.incrementingWithoutOverflow(udp443Flows)
        updatedAt = date
    }

    public mutating func recordOutboundCallback(
        offset: Int,
        byteCount: Int,
        classification: QUICInitialCandidate,
        at date: Date = Date()
    ) {
        outboundCallbacks = Self.incrementingWithoutOverflow(outboundCallbacks)
        if offset == 0 {
            zeroOffsetCallbacks = Self.incrementingWithoutOverflow(zeroOffsetCallbacks)
        }
        inspectedBytes = Self.addingWithoutOverflow(inspectedBytes, UInt64(max(0, byteCount)))
        switch classification {
        case .notQUICInitial:
            break
        case .version1:
            version1InitialCandidates = Self.incrementingWithoutOverflow(version1InitialCandidates)
        case .version2:
            version2InitialCandidates = Self.incrementingWithoutOverflow(version2InitialCandidates)
        case .unsupportedVersionLongHeader:
            unsupportedVersionLongHeaders = Self.incrementingWithoutOverflow(
                unsupportedVersionLongHeaders
            )
        }
        updatedAt = date
    }

    private static func incrementingWithoutOverflow(_ value: UInt64) -> UInt64 {
        value == .max ? .max : value + 1
    }

    private static func addingWithoutOverflow(_ left: UInt64, _ right: UInt64) -> UInt64 {
        let (sum, overflow) = left.addingReportingOverflow(right)
        return overflow ? .max : sum
    }
}
