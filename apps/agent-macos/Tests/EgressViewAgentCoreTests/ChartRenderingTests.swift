import AppKit
import SwiftUI
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewAgentUI

/// Draws the charts and looks at the pixels.
///
/// Four releases in a row shipped a chart defect that passed every test and
/// failed on the screen: the sankey keeping ten rows in a taller window, two
/// destinations shortening to the same string, those names truncated a second
/// time, the top axis label clipped against the frame. None of them could be
/// caught by asking the model a question -- the model was right each time.
///
/// So these render, and assert about what came out.
@MainActor
final class ChartRenderingTests: XCTestCase {
    /// Ink against the very top row means something was drawn with no room
    /// above it. For the timeline that is the axis label, which is the only
    /// place the chart says how big the tallest bucket was (P3-90).
    private func topRowHasInk(_ bitmap: NSBitmapImageRep) -> Bool {
        (0..<bitmap.pixelsWide).contains { x in
            guard let colour = bitmap.colorAt(x: x, y: 0) else { return false }
            let brightness = colour.redComponent + colour.greenComponent + colour.blueComponent
            return colour.alphaComponent > 0.1 && brightness < 2.4
        }
    }

    private func render(_ view: some View, width: CGFloat, height: CGFloat) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "描画できなかった")
        let data = try XCTUnwrap(image.tiffRepresentation)
        return try XCTUnwrap(NSBitmapImageRep(data: data))
    }

    private func spikyTimeline(metric: TrafficMetric) -> TimelineModel {
        let apps = ["Google Chrome Helper", "claude", "codex", "vmnet-natd", "ssh"]
        var rows: [AppTimelineTotal] = []
        for bucket in 0..<VisualizationSelection.bucketCount {
            for (index, app) in apps.enumerated() {
                let base = max(0, (bucket * 17 + index * 31) % 95 - index * 7)
                guard base > 0 else { continue }
                // One bucket forty times the rest: the shape that flattened a
                // day into nothing (P3-87) and made the top label matter.
                let value = base * (bucket == 41 && index == 0 ? 40 : 1)
                rows.append(.init(bucketIndex: bucket, processName: app,
                                  sessionCount: value, bytes: UInt64(value) * 32_768,
                                  observationsWithoutBytes: 0))
            }
        }
        return TimelineAggregator().aggregate(
            rows, selection: VisualizationSelection(scale: .day, metric: metric)
        )
    }

    func test時系列の一番上の軸ラベルが枠に接しない() throws {
        for metric in [TrafficMetric.sessions, .bytes] {
            for (width, height) in [(700.0, 260.0), (520.0, 200.0), (420.0, 160.0), (360.0, 130.0)] {
                let bitmap = try render(
                    AgentTimelineChart(model: spikyTimeline(metric: metric), scale: .day),
                    width: width, height: height
                )
                XCTAssertFalse(
                    topRowHasInk(bitmap),
                    "\(metric) \(Int(width))x\(Int(height)): 何かが上端に接している（軸ラベルが切れている疑い）"
                )
            }
        }
    }

    func test時系列は空のときも描ける() throws {
        let empty = TimelineAggregator().aggregate([], selection: VisualizationSelection())
        let bitmap = try render(AgentTimelineChart(model: empty, scale: .day), width: 420, height: 160)
        XCTAssertEqual(bitmap.pixelsWide, 840)
    }
}

/// The sankey's height arithmetic, which used to be unreachable.
///
/// P3-15 was `viewportHeight = 10 * rowHeight`: the diagram stayed 210 points
/// tall however large the window grew. The suite passed throughout, because
/// the number lived inside a view and the only way to ask it anything was to
/// draw it and look.
@MainActor
final class SankeyViewportTests: XCTestCase {
    func test行数が高さで変わる() {
        // The defect, stated as a test: ten rows whatever the height.
        let short = SankeyViewport.visibleRows(inHeight: 210)
        let tall = SankeyViewport.visibleRows(inHeight: 500)
        XCTAssertGreaterThan(tall, short, "高さを増やしても表示行数が変わらない（P3-15）")
    }

    func test背の低いカードでも三行は出る() {
        XCTAssertGreaterThanOrEqual(
            SankeyViewport.visibleRows(inHeight: SankeyViewport.minimumHeight),
            SankeyViewport.minimumRows,
            "最小の高さで最小の行数に満たない"
        )
    }

    func test中身の高さは行数に比例する() {
        let one = SankeyViewport.contentHeight(rows: 1)
        let ten = SankeyViewport.contentHeight(rows: 10)
        XCTAssertEqual(ten - one, 9 * SankeyViewport.rowHeight, accuracy: 0.01)
    }

    func test行が無くても高さは負にならない() {
        XCTAssertGreaterThan(SankeyViewport.contentHeight(rows: 0), 0)
        XCTAssertEqual(SankeyViewport.visibleRows(inHeight: 0), 0)
    }

    func test抽出しても数値は変わっていない() {
        // The values the view used before the arithmetic moved out. If either
        // constant drifts, the layout drifts with it and this says so.
        XCTAssertEqual(SankeyViewport.rowHeight, 18)
        XCTAssertEqual(SankeyViewport.headerHeight, 17)
        XCTAssertEqual(SankeyViewport.minimumHeight, 17 + 3 * 18)
        XCTAssertEqual(SankeyViewport.contentHeight(rows: 30), 17 + 30 * 18)
    }
}
