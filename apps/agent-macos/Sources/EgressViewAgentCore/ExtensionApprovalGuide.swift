import Foundation

/// Where, on this Mac, the network extension is approved -- step by step.
///
/// "Approve the System Extension in System Settings" was all the app said, and
/// on macOS 27 that was not enough to find it: the extension is not in the
/// list System Settings shows first (extensions by app), only after switching
/// to "By Category" and opening Network Extensions. Measured on one Mac
/// 2026-10-09, after reinstalling: the request had reached macOS twice and
/// was waiting for the user, and nothing on screen said where to look.
///
/// Since macOS 15 the approval lives in General > Login Items & Extensions.
/// Before that it was a banner in Privacy & Security with an Allow button.
/// Only the macOS 27 path has been followed on a real Mac.
///
/// The steps are English keys, translated by the app's string table, so this
/// stays free of UI code and can be tested.
public enum ExtensionApprovalGuide {
    /// Opens System Settings at the pane that holds the approval.
    public static func settingsURL(for version: OperatingSystemVersion) -> URL {
        if version.majorVersion >= 15 {
            return URL(string: "x-apple.systempreferences:com.apple.LoginItems-Settings.extension")!
        }
        return URL(string: "x-apple.systempreferences:com.apple.preference.security?General")!
    }

    public static func steps(for version: OperatingSystemVersion) -> [String] {
        if version.majorVersion >= 15 {
            return [
                "In System Settings, open General > Login Items & Extensions.",
                "Under Extensions, choose By Category. (By App does not list EgressView until it is approved.)",
                "Click the info button next to Network Extensions and turn on EgressView Agent.",
                "Enter your password, then choose Allow if macOS asks about filtering network content.",
            ]
        }
        return [
            "In System Settings, open Privacy & Security.",
            "Under Security, find the message that system software from EgressView Agent was blocked, and click Allow.",
            "Enter your password, then choose Allow if macOS asks about filtering network content.",
        ]
    }
}
