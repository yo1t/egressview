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

    override func setUp() {
        super.setUp()
        AgentStrings.resourceDirectoryOverride = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // EgressViewAgentCoreTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // agent-macos
            .appendingPathComponent("Xcode/Host")
    }

    private func render(_ view: some View, width: CGFloat, height: CGFloat) throws -> NSBitmapImageRep {
        let renderer = ImageRenderer(content: view.frame(width: width, height: height))
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "描画できなかった")
        let data = try XCTUnwrap(image.tiffRepresentation)
        return try XCTUnwrap(NSBitmapImageRep(data: data))
    }

    /// The vertical runs of ink in the left gutter, in pixels.
    ///
    /// The axis labels are the only thing drawn left of the plot, so each run
    /// is one label -- unless two of them touch, in which case the runs merge
    /// and the tallest run doubles. That is P3-104 seen from the pixels.
    private func gutterInkRuns(_ bitmap: NSBitmapImageRep, gutterWidth: Int) -> [Range<Int>] {
        var runs: [Range<Int>] = []
        var current = 0
        for y in 0..<bitmap.pixelsHigh {
            let inked = (0..<min(gutterWidth, bitmap.pixelsWide)).contains { x in
                guard let colour = bitmap.colorAt(x: x, y: y) else { return false }
                let brightness = colour.redComponent + colour.greenComponent + colour.blueComponent
                return colour.alphaComponent > 0.1 && brightness < 2.4
            }
            if inked {
                current += 1
            } else if current > 0 {
                runs.append((y - current)..<y)
                current = 0
            }
        }
        if current > 0 { runs.append((bitmap.pixelsHigh - current)..<bitmap.pixelsHigh) }
        return runs
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

    /// Both languages. Japanese text has a different width and height, and a
    /// label that fits in one can be cut in the other -- the render tool
    /// showed only English until 2026-09-11, because it found no strings and
    /// got the keys back, which are English sentences.
    private func withLanguage(_ language: AgentLanguage, _ body: () throws -> Void) rethrows {
        let previous = UserDefaults.standard.string(forKey: AgentLanguage.defaultsKey)
        UserDefaults.standard.set(language.rawValue, forKey: AgentLanguage.defaultsKey)
        defer { UserDefaults.standard.set(previous, forKey: AgentLanguage.defaultsKey) }
        try body()
    }

    func test時系列の一番上の軸ラベルが枠に接しない() throws {
        for language in [AgentLanguage.english, .japanese] {
            try withLanguage(language) {
                for metric in [TrafficMetric.sessions, .bytes] {
                    for (width, height) in [(700.0, 260.0), (520.0, 200.0), (420.0, 160.0), (360.0, 130.0)] {
                        let bitmap = try render(
                            AgentTimelineChart(model: spikyTimeline(metric: metric), scale: .day),
                            width: width, height: height
                        )
                        XCTAssertFalse(
                            topRowHasInk(bitmap),
                            "\(language.rawValue) \(metric) \(Int(width))x\(Int(height)): 何かが上端に接している"
                        )
                    }
                }
            }
        }
    }

    /// The sizes the plot is drawn at, from a wide window down to a card with
    /// almost nothing left. The short end is where P3-104 lived: the labels
    /// are centred on their gridlines, so the space between them is the space
    /// between the lines, and that follows the window.
    private static let plotSizes: [(CGFloat, CGFloat)] = [
        (700, 260), (520, 200), (420, 160), (360, 130),
        (360, 96), (360, 70), (420, 64), (420, 56), (420, 48), (420, 40), (420, 34),
    ]

    func test縦軸のラベルが隣とぶつからない() throws {
        // Measured 2026-09-11 with the three fixed fractions still in place:
        // at 420x40 the gaps were 2px and 1px, and at 420x34 the three labels
        // merged into a single 35px block. Readable, and a clump -- which is
        // the complaint.
        let minimumGap = Int(TimelineAxisLabels.minimumGap * 2)  // scale = 2
        for language in [AgentLanguage.english, .japanese] {
            try withLanguage(language) {
                for metric in [TrafficMetric.sessions, .bytes] {
                    for (width, height) in Self.plotSizes {
                        let bitmap = try render(
                            AgentTimelinePlot(model: spikyTimeline(metric: metric),
                                              scale: .day, sleepPeriods: []),
                            width: width, height: height
                        )
                        let where_ = "\(language.rawValue) \(metric) \(Int(width))x\(Int(height))"
                        let runs = gutterInkRuns(bitmap, gutterWidth: 110)
                        // The top value is never given up: without it the
                        // chart shows a shape and no magnitude.
                        XCTAssertFalse(runs.isEmpty, "\(where_): 軸ラベルがひとつも無い")
                        XCTAssertGreaterThan(
                            runs[0].lowerBound, 0, "\(where_): 一番上のラベルが枠に接している"
                        )
                        for run in runs {
                            XCTAssertLessThanOrEqual(
                                run.count, 20,
                                "\(where_): 高さ\(run.count)pxの塊がある。ラベル同士がくっついている"
                            )
                        }
                        for (upper, lower) in zip(runs, runs.dropFirst()) {
                            XCTAssertGreaterThanOrEqual(
                                lower.lowerBound - upper.upperBound, minimumGap,
                                "\(where_): ラベルの間が\(lower.lowerBound - upper.upperBound)pxしかない"
                            )
                        }
                    }
                }
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

/// Which values the vertical axis says, and how many of them fit.
///
/// P3-104 was `[0.0, 0.5, 1.0]` written into the drawing: three labels at
/// every card height, which in a short card became a clump. As with
/// `SankeyViewport`, the number that was wrong could only be reached by
/// drawing it.
@MainActor
final class TimelineAxisLabelsTests: XCTestCase {
    /// A label box measured from the 9pt system font the chart draws with.
    private let labelHeight: CGFloat = 11

    func test高さが足りなければラベルを減らす() {
        let tall = TimelineAxisLabels.fractions(plotHeight: 200, labelHeight: labelHeight)
        let short = TimelineAxisLabels.fractions(plotHeight: 16, labelHeight: labelHeight)
        let tiny = TimelineAxisLabels.fractions(plotHeight: 8, labelHeight: labelHeight)
        XCTAssertEqual(tall, [0, 0.5, 1])
        XCTAssertEqual(short, [0, 1])
        XCTAssertEqual(tiny, [1])
    }

    func test最大値のラベルはどの高さでも残る() {
        // The middle tick is a help; the top is the only place the chart says
        // how big the tallest bucket is. Giving that up would undo P3-90.
        for height in stride(from: CGFloat(0), through: 300, by: 1) {
            let fractions = TimelineAxisLabels.fractions(
                plotHeight: height, labelHeight: labelHeight
            )
            XCTAssertEqual(fractions.last, 1, "高さ\(height)で最大値のラベルが消えた")
        }
    }

    func testどの高さでもラベル同士は離れている() {
        for height in stride(from: CGFloat(0), through: 300, by: 1) {
            let fractions = TimelineAxisLabels.fractions(
                plotHeight: height, labelHeight: labelHeight
            )
            XCTAssertFalse(
                TimelineAxisLabels.labelsCollide(
                    fractions, plotHeight: height, labelHeight: labelHeight
                ),
                "高さ\(height)でラベルが重なる"
            )
        }
    }

    func test固定の三つだったころは重なる() {
        // The defect, stated as a test. Without this the one above could pass
        // by never returning anything, and a collision check that cannot see
        // a collision is the check that let P3-104 through.
        XCTAssertTrue(
            TimelineAxisLabels.labelsCollide([0, 0.5, 1], plotHeight: 16, labelHeight: labelHeight),
            "旧来の三つ固定でも重ならないことになっている"
        )
    }

    func test間隔はゼロではない() {
        // Boxes that merely fail to overlap still read as one block.
        XCTAssertGreaterThan(TimelineAxisLabels.minimumGap, 0)
    }
}
