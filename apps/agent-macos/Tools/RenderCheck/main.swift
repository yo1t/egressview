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

        for metric in [TrafficMetric.sessions, .bytes] {
            let name = metric == .bytes ? "bytes" : "connections"

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
    }

    @MainActor
    private static func save<V: View>(_ view: V, width: CGFloat, height: CGFloat, to path: String) {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
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
