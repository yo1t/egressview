import AppKit

let application = NSApplication.shared
let delegate = MainActor.assumeIsolated { AgentAppDelegate() }
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
