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
            publicHeadersPath: "include",
            linkerSettings: [.linkedLibrary("bsm")]
        ),
        .target(
            name: "EgressViewAgentCore",
            dependencies: ["CLibProcBridge"],
            // The same country outlines the Web UI uses, so the two look alike.
            // Carried in the app rather than fetched: MapKit would reach
            // Apple's tile servers, which an agent that must work offline
            // cannot rely on.
            resources: [.copy("Resources/world-atlas-countries-110m.json")],
            // System SQLite. The local history needs indexed range queries and
            // grouped aggregation, and adding a package dependency for storage
            // the OS already ships would be a poor trade.
            linkerSettings: [.linkedLibrary("sqlite3")]
        ),
        .target(
            name: "EgressViewNetworkExtension",
            dependencies: ["EgressViewAgentCore", "CLibProcBridge"]
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
