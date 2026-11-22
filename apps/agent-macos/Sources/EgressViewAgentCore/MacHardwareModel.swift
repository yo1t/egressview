import Darwin
import Foundation

/// The model identifier of this Mac, such as "Mac14,2", for the Hub's device
/// list (P3-199). Apple publishes which product each identifier is, so the
/// person reading the list can tell a MacBook Air from a Mac mini.
public enum MacHardwareModel {
    public static func current() -> String? {
        var size = 0
        guard sysctlbyname("hw.model", nil, &size, nil, 0) == 0, size > 1 else { return nil }
        var bytes = [CChar](repeating: 0, count: size)
        guard sysctlbyname("hw.model", &bytes, &size, nil, 0) == 0 else { return nil }
        let model = String(cString: bytes).trimmingCharacters(in: .whitespacesAndNewlines)
        return model.isEmpty ? nil : String(model.prefix(100))
    }
}
