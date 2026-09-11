// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "EgressViewMacAgent",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "EgressViewAgentCore", targets: ["EgressViewAgentCore"]),
        .library(name: "EgressViewNetworkExtension", targets: ["EgressViewNetworkExtension"]),
        .executable(name: "egressview-agent-spike", targets: ["EgressViewAgentSpike"]),
        .executable(name: "render-check", targets: ["RenderCheck"]),
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
        // The charts, rendered offscreen so their layout can be checked without
        // installing a build. Sources are listed rather than taken wholesale:
        // `Xcode/Host` also holds the application's own `main.swift`, and two
        // entry points cannot share a target.
        .executableTarget(
            name: "RenderCheck",
            dependencies: ["EgressViewAgentCore"],
            path: "Xcode/Host",
            // The `.lproj` bundles beside these sources belong to the Xcode
            // application, not to this tool. Excluding them keeps the manifest
            // from needing a `defaultLocalization` it has no use for.
            exclude: ["en.lproj", "ja.lproj", "Assets.xcassets", "Info.plist"],
            sources: [
                "RenderCheck.swift",
                "AgentSankeyChart.swift",
                "AgentTimelineChart.swift",
                "AgentChartComponents.swift",
                "AgentLocalization.swift",
            ]
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
