import AppKit
import EgressViewAgentCore
import EgressViewAgentUI
import SwiftUI

// Renders the charts offscreen and writes PNGs, so their layout can be checked
// without installing a build and looking at a screen.
//
// The Windows agent has had `tools/render-check` since before this; the Mac
// side had nothing, and four releases in a row shipped a chart defect that
// only the screen revealed (P3-86, P3-89, P3-15, P3-90). A screenshot of the
// running agent cannot be taken here at all -- the app is `LSUIElement`, which
// makes it invisible to every screen-control tool -- so the choice was between
// this and asking a person every time.
enum RenderCheck {
    @MainActor
    static func main() {
        let output = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "render-check"
        try? FileManager.default.createDirectory(
            atPath: output, withIntermediateDirectories: true
        )

        // Point at the application's `.lproj` folders. Without this the tool
        // is its own `Bundle.main`, finds no strings, and gets the key back --
        // which reads as English, because the keys are English sentences. The
        // output looked right while showing nothing translated.
        AgentStrings.resourceDirectoryOverride = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Tools/RenderCheck
            .deletingLastPathComponent()   // Tools
            .deletingLastPathComponent()   // agent-macos
            .appendingPathComponent("Xcode/Host")

        // Shaped like the real thing: one destination taking most of the
        // volume, a long tail, names that collide when shortened, and an IPv6
        // literal. Those are the cases that were wrong on the screen.
        let pairs: [AppDestinationTotal] = [
            .init(processName: "Google Chrome Helper", destination: "cdn-windows-client-a.example.com",
                  sessionCount: 1005, bytes: 2_362_232_012, observationsWithoutBytes: 0),
            .init(processName: "vmnet-natd", destination: "cdn-windows-client-b.example.com",
                  sessionCount: 822, bytes: 149_100_134, observationsWithoutBytes: 0),
            .init(processName: "mDNSResponder", destination: "240d:1a:5aa:1200:0000:0000:aec4:ba60",
                  sessionCount: 721, bytes: 97_400_112, observationsWithoutBytes: 0),
            .init(processName: "claude", destination: "api.anthropic.com",
                  sessionCount: 268, bytes: 48_700_000, observationsWithoutBytes: 0),
            .init(processName: "ssh", destination: "192.0.2.1",
                  sessionCount: 81, bytes: 46_400_000, observationsWithoutBytes: 12),
        ]

        // One bucket far larger than the rest: the shape that flattened a day
        // of traffic into nothing (P3-87), and where the topmost axis label is
        // the only place the chart says how big that bucket was (P3-90).
        let apps = ["Google Chrome Helper", "claude", "codex", "vmnet-natd", "ssh"]
        var rows: [AppTimelineTotal] = []
        for bucket in 0..<VisualizationSelection.bucketCount {
            for (index, app) in apps.enumerated() {
                let base = max(0, (bucket * 17 + index * 31) % 95 - index * 7)
                let spike = bucket == 41 && index == 0 ? 40 : 1
                guard base > 0 else { continue }
                rows.append(.init(
                    bucketIndex: bucket, processName: app,
                    sessionCount: base * spike,
                    bytes: UInt64(base * spike) * 32_768,
                    observationsWithoutBytes: 0
                ))
            }
        }

        // Both languages: Japanese text has a different width, and a label
        // that fits in one can be cut in the other (P3-89).
        for language in ["en", "ja"] {
            // Through the same defaults key the application writes, so the
            // tool takes the path the product takes rather than a back door.
            UserDefaults.standard.set(
                language == "ja" ? AgentLanguage.japanese.rawValue : AgentLanguage.english.rawValue,
                forKey: AgentLanguage.defaultsKey
            )

        for metric in [TrafficMetric.sessions, .bytes] {
            let name = "\(language)-" + (metric == .bytes ? "bytes" : "connections")

            let sankey = SankeyAggregator().aggregate(pairs, metric: metric)
            for (width, height) in [(700.0, 260.0), (520.0, 200.0), (420.0, 160.0), (360.0, 130.0)] {
                save(AgentSankeyChart(model: sankey),
                     width: width, height: height,
                     to: "\(output)/sankey-\(name)-\(Int(width))x\(Int(height)).png")
            }

            let selection = VisualizationSelection(scale: .day, metric: metric)
            let timeline = TimelineAggregator().aggregate(rows, selection: selection)
            for (width, height) in [(700.0, 260.0), (520.0, 200.0), (420.0, 160.0), (360.0, 130.0)] {
                save(AgentTimelineChart(model: timeline, scale: .day),
                     width: width, height: height,
                     to: "\(output)/timeline-\(name)-\(Int(width))x\(Int(height)).png")
            }
        }

            // The expanded country map (P3-109). One drawing per language: it
            // carries no per-metric content, but its heading and its list do.
            let atlas = try? WorldAtlas.bundled()
            let visited: Set<String> = ["JP", "US", "GB", "DE", "SG", "AU", "BR", "ZA"]
            let history = visited.sorted().enumerated().map { index, code in
                CountryVisitSummary(
                    countryCode: code,
                    firstObservedAt: Date(timeIntervalSince1970: 1_755_200_000),
                    lastObservedAt: Date(timeIntervalSince1970: 1_757_600_000),
                    lastSiteName: "",
                    lastProcessName: "Claude Helper",
                    connectionCount: 1_173_996 - index * 100_000
                )
            }
            // The afterglow, caught at three points of its fade. A still
            // picture cannot show that it moves, but it can show that the
            // brightness is where it should be.
            let glowAt = Date(timeIntervalSince1970: 1_757_700_000)
            // Control: the same call site with nothing lit.
            save(AgentWorldMapChart(atlas: atlas, visitedCountryCodes: visited,
                                    glow: CountryGlow(), now: Date()),
                 width: 1100, height: 700,
                 to: "\(output)/worldmap-control-\(language).png")
            for seconds in [0.0, 2.0, 5.0] {
                var glow = CountryGlow()
                glow.touch(["JP", "BR"], at: glowAt)
                save(AgentWorldMapChart(
                        atlas: atlas, visitedCountryCodes: visited, glow: glow,
                        now: glowAt.addingTimeInterval(seconds)
                     ),
                     width: 1100, height: 700,
                     to: "\(output)/worldmap-glow-\(language)-\(Int(seconds))s.png")
            }

            for (width, height) in [(1440.0, 900.0), (1100.0, 700.0), (820.0, 560.0)] {
                save(AgentWorldMapChart(atlas: atlas, visitedCountryCodes: visited),
                     width: width, height: height,
                     to: "\(output)/worldmap-\(language)-\(Int(width))x\(Int(height)).png")
                save(AgentCountryAtlasView(
                        atlas: atlas, visitedCountryCodes: visited,
                        countryHistory: history, onCollapse: {}
                     ),
                     width: width, height: height,
                     to: "\(output)/country-atlas-\(language)-\(Int(width))x\(Int(height)).png")
            }
        }
    }

    @MainActor
    private static func save<V: View>(_ view: V, width: CGFloat, height: CGFloat, to path: String) {
        // On the window's own background, not on nothing.
        //
        // These were transparent, and a chart that draws pale colours at low
        // opacity then reads as whatever the viewer happens to composite it
        // over. On 2026-09-12 that cost three rounds chasing a world map that
        // looked black: the pixels were right the whole time and the backdrop
        // was not there. A picture meant for checking has to look like the
        // thing it is checking.
        let opaque = view
            .frame(width: width, height: height)
            .background(Color(nsColor: .windowBackgroundColor))
        let renderer = ImageRenderer(content: opaque)
        renderer.scale = 2
        guard let image = renderer.nsImage,
              let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff),
              let png = bitmap.representation(using: .png, properties: [:]) else {
            FileHandle.standardError.write(Data("could not render \(path)\n".utf8))
            exit(1)
        }
        try? png.write(to: URL(fileURLWithPath: path))
        print("\(path)  \(Int(width))x\(Int(height))")
    }
}

MainActor.assumeIsolated { RenderCheck.main() }
