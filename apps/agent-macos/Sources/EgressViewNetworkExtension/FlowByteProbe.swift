/// Diagnostic-only accounting for bytes shown to a filter data provider.
/// This is not a traffic counter: bytes passed without a callback are unknown.
public struct FlowByteProbe: Sendable {
    public private(set) var furthestObservedEnd: UInt64 = 0
    public private(set) var hasGap = false
    public private(set) var callbackCount: UInt64 = 0
    public private(set) var presentedBytes: UInt64 = 0
    public private(set) var zeroOffsetCallbacks: UInt64 = 0

    public init() {}

    public mutating func observe(offset: Int, length: Int) {
        guard length > 0 else { return }
        callbackCount = callbackCount == .max ? .max : callbackCount + 1
        let (total, totalOverflow) = presentedBytes.addingReportingOverflow(UInt64(length))
        presentedBytes = totalOverflow ? .max : total
        if offset == 0 {
            zeroOffsetCallbacks = zeroOffsetCallbacks == .max ? .max : zeroOffsetCallbacks + 1
        }
        guard offset >= 0 else {
            hasGap = true
            return
        }
        let start = UInt64(offset)
        let (end, overflow) = start.addingReportingOverflow(UInt64(length))
        guard !overflow else {
            hasGap = true
            return
        }
        if start > furthestObservedEnd { hasGap = true }
        furthestObservedEnd = max(furthestObservedEnd, end)
    }

    /// A filtered flow is usable only when both directions began at zero and
    /// neither direction was released before the closing report.
    public static func completeCounts(
        inbound: FlowByteProbe,
        outbound: FlowByteProbe,
        truncated: Bool
    ) -> (inbound: UInt64, outbound: UInt64)? {
        guard !truncated,
              !inbound.hasGap, !outbound.hasGap,
              inbound.furthestObservedEnd > 0,
              outbound.furthestObservedEnd > 0
        else { return nil }
        return (inbound.furthestObservedEnd, outbound.furthestObservedEnd)
    }
}
