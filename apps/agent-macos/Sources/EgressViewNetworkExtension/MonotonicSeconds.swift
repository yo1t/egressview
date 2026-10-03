import Foundation

/// Seconds on a clock that only moves forward, counted from when this process
/// first asked. For measuring intervals inside the extension.
///
/// Not the process-info uptime: that reads the system boot time, an API Apple
/// requires a declared reason for, and nothing here needs the boot time itself
/// -- only how long since an earlier reading.
public enum MonotonicSeconds {
    private static let origin = ContinuousClock.now

    public static func now() -> TimeInterval {
        let elapsed = origin.duration(to: .now).components
        return TimeInterval(elapsed.seconds) + TimeInterval(elapsed.attoseconds) / 1e18
    }
}
