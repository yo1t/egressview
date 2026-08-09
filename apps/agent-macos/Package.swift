// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "EgressViewMacAgent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "EgressViewAgentCore", targets: ["EgressViewAgentCore"]),
        .library(name: "EgressViewNetworkExtension", targets: ["EgressViewNetworkExtension"]),
        .executable(name: "egressview-agent-spike", targets: ["EgressViewAgentSpike"]),
    ],
    targets: [
        .target(
            name: "CLibProcBridge",
            publicHeadersPath: "include"
        ),
        .target(
            name: "EgressViewAgentCore",
            dependencies: ["CLibProcBridge"]
        ),
        .target(
            name: "EgressViewNetworkExtension",
            dependencies: ["EgressViewAgentCore"]
        ),
        .executableTarget(
            name: "EgressViewAgentSpike",
            dependencies: ["EgressViewAgentCore"]
        ),
        .testTarget(
            name: "EgressViewAgentCoreTests",
            dependencies: ["EgressViewAgentCore", "EgressViewNetworkExtension"]
        ),
    ],
    swiftLanguageModes: [.v5]
)
