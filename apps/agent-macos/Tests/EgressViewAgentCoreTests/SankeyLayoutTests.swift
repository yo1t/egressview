import CoreGraphics
import Foundation
import XCTest
@testable import EgressViewAgentCore

private func model(_ rows: [(String, String, Int)], limit: Int = 8) -> SankeyModel {
    SankeyAggregator(limit: limit).aggregate(
        rows.map {
            AppDestinationTotal(
                processName: $0.0, destination: $0.1, sessionCount: $0.2,
                bytes: 0, observationsWithoutBytes: 0
            )
        },
        metric: .sessions
    )
}

final class SankeyLayoutTests: XCTestCase {
    private let size = CGSize(width: 400, height: 300)

    func testTheColumnFillsTheViewHeightWhateverTheNodeCount() {
        for count in [1, 2, 5, 9] {
            let rows = (0..<count).map { ("app-\($0)", "host-\($0).example.com", 10) }
            let layout = SankeyLayout(nodeWidth: 12, nodeGap: 6).layout(model(rows), in: size)
            let last = try? XCTUnwrap(layout.apps.last)
            XCTAssertEqual(
                last?.rect.maxY ?? 0, size.height, accuracy: 0.001,
                "\(count) nodes should still reach the bottom"
            )
        }
    }

    func testNodeHeightIsProportionalToItsShare() {
        let layout = SankeyLayout(nodeGap: 0).layout(
            model([("Big", "a.example.com", 75), ("Small", "b.example.com", 25)]), in: size
        )
        let big = layout.apps.first { $0.name == "Big" }
        let small = layout.apps.first { $0.name == "Small" }
        XCTAssertEqual(big?.rect.height ?? 0, size.height * 0.75, accuracy: 0.001)
        XCTAssertEqual(small?.rect.height ?? 0, size.height * 0.25, accuracy: 0.001)
    }

    func testRibbonsStackWithinTheirNodeWithoutOverlapping() {
        let layout = SankeyLayout(nodeGap: 0).layout(
            model([
                ("Safari", "a.example.com", 30),
                ("Safari", "b.example.com", 20),
                ("Safari", "c.example.com", 10),
            ]), in: size
        )
        let app = try? XCTUnwrap(layout.apps.first)
        let ranges = layout.ribbons
            .filter { $0.source == "Safari" }
            .map(\.sourceRange)
            .sorted { $0.lowerBound < $1.lowerBound }

        XCTAssertEqual(ranges.count, 3)
        XCTAssertEqual(ranges.first?.lowerBound ?? -1, app?.rect.minY ?? -2, accuracy: 0.001)
        XCTAssertEqual(ranges.last?.upperBound ?? -1, app?.rect.maxY ?? -2, accuracy: 0.001)
        for (earlier, later) in zip(ranges, ranges.dropFirst()) {
            XCTAssertEqual(earlier.upperBound, later.lowerBound, accuracy: 0.001)
        }
    }

    func testRibbonThicknessMatchesItsShareOfBothEnds() {
        let layout = SankeyLayout(nodeGap: 0).layout(
            model([
                ("Safari", "shared.example.com", 30),
                ("Mail", "shared.example.com", 10),
            ]), in: size
        )
        let safari = try? XCTUnwrap(layout.ribbons.first { $0.source == "Safari" })
        let mail = try? XCTUnwrap(layout.ribbons.first { $0.source == "Mail" })

        // Safari is three quarters of the shared destination.
        let safariTarget = (safari?.targetRange.upperBound ?? 0) - (safari?.targetRange.lowerBound ?? 0)
        let mailTarget = (mail?.targetRange.upperBound ?? 0) - (mail?.targetRange.lowerBound ?? 0)
        XCTAssertEqual(safariTarget / (safariTarget + mailTarget), 0.75, accuracy: 0.001)
        // Each app sends everything it has to this one destination.
        let safariSource = (safari?.sourceRange.upperBound ?? 0) - (safari?.sourceRange.lowerBound ?? 0)
        XCTAssertEqual(safariSource, layout.apps.first { $0.name == "Safari" }?.rect.height ?? -1, accuracy: 0.001)
    }

    func testDegenerateSizesProduceNothingRatherThanNonsense() {
        let diagram = model([("Safari", "a.example.com", 5)])
        for bad in [CGSize(width: 0, height: 0), CGSize(width: 400, height: 0), CGSize(width: 5, height: 300)] {
            let layout = SankeyLayout().layout(diagram, in: bad)
            XCTAssertTrue(layout.apps.isEmpty, "\(bad) should not lay out")
            XCTAssertTrue(layout.ribbons.isEmpty)
        }
    }

    func testAnEmptyDiagramLaysOutNothing() {
        let layout = SankeyLayout().layout(model([]), in: size)
        XCTAssertTrue(layout.apps.isEmpty)
        XCTAssertTrue(layout.ribbons.isEmpty)
    }

    func testGapsNeverPushTheColumnPastTheView() {
        // Many nodes with a large gap: the nodes shrink, the column does not
        // overflow.
        let rows = (0..<9).map { ("app-\($0)", "host-\($0).example.com", 10) }
        let layout = SankeyLayout(nodeGap: 40).layout(model(rows), in: CGSize(width: 400, height: 300))
        for frame in layout.apps {
            XCTAssertGreaterThanOrEqual(frame.rect.height, 0)
            XCTAssertLessThanOrEqual(frame.rect.maxY, 300.001)
        }
    }
}

final class SankeyAccessibilityTests: XCTestCase {
    func testTheSummarySaysWhatTheDiagramShows() {
        let diagram = model([
            ("Safari", "example.com", 70),
            ("Mail", "mail.example.com", 30),
        ])
        let summary = diagram.accessibilitySummary(
            metricName: { _ in "sessions" },
            formattedValue: { value, _ in String(Int(value)) },
            empty: "No traffic in this period.",
            template: { metric, total, apps, destinations in
                "\(total) \(metric) across \(apps) apps and \(destinations) destinations."
            },
            leaders: { app, destination, share in
                "\(app) accounts for \(share) percent; the busiest destination is \(destination)."
            }
        )

        XCTAssertEqual(
            summary,
            "100 sessions across 2 apps and 2 destinations. "
            + "Safari accounts for 70 percent; the busiest destination is example.com."
        )
    }

    func testAnEmptyDiagramSaysSoRatherThanReadingAsAGroup() {
        let summary = model([]).accessibilitySummary(
            metricName: { _ in "sessions" },
            formattedValue: { value, _ in String(Int(value)) },
            empty: "No traffic in this period.",
            template: { _, _, _, _ in "unused" },
            leaders: { _, _, _ in "unused" }
        )
        XCTAssertEqual(summary, "No traffic in this period.")
    }
}
