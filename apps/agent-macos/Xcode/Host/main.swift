import AppKit

let application = NSApplication.shared
let delegate = AgentAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
