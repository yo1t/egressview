import Dispatch
import NetworkExtension

NEProvider.startSystemExtensionMode()
FullMonitoringXPCServer.shared.start()
dispatchMain()
