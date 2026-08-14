import Foundation
import XCTest
@testable import EgressViewAgentCore

private let anchor = Date(timeIntervalSince1970: 1_800_000_000)

private func row(
    _ app: String, bucket: Int, sessions: Int, bytes: UInt64 = 0, withoutBytes: Int = 0
) -> AppTimelineTotal {
    AppTimelineTotal(
        bucketIndex: bucket, processName: app, sessionCount: sessions,
        bytes: bytes, observationsWithoutBytes: withoutBytes
    )
}

final class VisualizationSelectionTests: XCTestCase {
    func testTheWindowEndsWhereTheUserPutItRatherThanSlidingWithTheClock() {
        let selection = VisualizationSelection(scale: .day, metric: .sessions, end: anchor)
        XCTAssertEqual(selection.end, anchor)
        XCTAssertEqual(selection.start, anchor.addingTimeInterval(-86_400))
    }

    func testTheNumberOfPointsDoesNotGrowWithTheWindow() {
        // Thirty days must cost no more to draw than one hour.
        for scale in TimeScale.allCases {
            let selection = VisualizationSelection(scale: scale, end: anchor)
            XCTAssertEqual(
                selection.bucketDuration * Double(VisualizationSelection.bucketCount),
                scale.duration,
                accuracy: 0.001
            )
        }
    }

    func testAScaleTheHistoryCannotFillIsNotOffered() {
        // Offering a month to someone keeping one day would draw twenty-nine
        // empty buckets and call it their traffic.
        let oneDay = ObservationRetention(retentionDays: 1, rawDays: 1)
        XCTAssertEqual(
            VisualizationSelection.availableScales(retention: oneDay), [.hour, .sixHours, .day]
        )
        let ninety = ObservationRetention(retentionDays: 90, rawDays: 14)
        XCTAssertEqual(VisualizationSelection.availableScales(retention: ninety).count, 5)
    }

    func testTheByteViewIsNotOfferedBeforeAnyBytesHaveBeenMeasured() {
        XCTAssertEqual(VisualizationSelection.availableMetrics(hasMeasuredBytes: false), [.sessions])
        XCTAssertEqual(
            Set(VisualizationSelection.availableMetrics(hasMeasuredBytes: true)),
            Set(TrafficMetric.allCases)
        )
    }

    func testAnImpossibleSelectionIsCorrectedRatherThanDrawnEmpty() {
        let selection = VisualizationSelection(scale: .month, metric: .bytes, end: anchor)
        let corrected = selection.clamped(
            retention: ObservationRetention(retentionDays: 7, rawDays: 7),
            hasMeasuredBytes: false
        )
        XCTAssertEqual(corrected.scale, .week)
        XCTAssertEqual(corrected.metric, .sessions)
        XCTAssertEqual(corrected.end, anchor, "the window the user chose is kept")
    }

    func testDraggingARangeKeepsTheMetricTheUserWasReading() {
        let selection = VisualizationSelection(scale: .month, metric: .bytes, end: anchor)
        let narrowed = selection.selecting(
            from: anchor.addingTimeInterval(-7_200), to: anchor.addingTimeInterval(-3_600)
        )
        XCTAssertEqual(narrowed.metric, .bytes, "changing the period must not reset the metric")
        XCTAssertEqual(narrowed.scale, .hour)
        XCTAssertEqual(narrowed.end, anchor.addingTimeInterval(-3_600))
    }
}

final class TimelineAggregatorTests: XCTestCase {
    private let selection = VisualizationSelection(scale: .day, metric: .sessions, end: anchor)

    func testEverySeriesCoversEveryBucketSoTheChartHasNoGaps() {
        let model = TimelineAggregator().aggregate([
            row("Safari", bucket: 0, sessions: 5),
            row("Safari", bucket: 30, sessions: 7),
        ], selection: selection)

        XCTAssertEqual(model.bucketStarts.count, VisualizationSelection.bucketCount)
        XCTAssertEqual(model.series.first?.values.count, VisualizationSelection.bucketCount)
        XCTAssertEqual(model.series.first?.values[0], 5)
        XCTAssertEqual(model.series.first?.values[1], 0, "a quiet bucket really is zero sessions")
        XCTAssertEqual(model.total, 12)
    }

    func testBucketStartsSpanTheSelectedWindow() {
        let model = TimelineAggregator().aggregate([row("Safari", bucket: 0, sessions: 1)],
                                                   selection: selection)
        XCTAssertEqual(model.bucketStarts.first, selection.start)
        XCTAssertEqual(
            model.bucketStarts.last?.addingTimeInterval(model.bucketDuration),
            selection.end
        )
    }

    func testFoldingKeepsTheTotalAndPutsTheRemainderLast() {
        let rows = (0..<20).map { row("app-\($0)", bucket: $0 % 60, sessions: 20 - $0) }
        let model = TimelineAggregator(limit: 3).aggregate(rows, selection: selection)

        XCTAssertEqual(model.series.count, 4, "three applications plus the remainder")
        XCTAssertTrue(model.series.last?.isRemainder == true)
        XCTAssertEqual(
            model.series.reduce(0) { $0 + $1.total }, model.total,
            "folding must not lose traffic"
        )
    }

    func testTheBeaconAndTheUploadSwapPlacesWhenTheMetricChanges() {
        let rows = [
            row("Beacon", bucket: 5, sessions: 10_000, bytes: 10_000_000),
            row("Uploader", bucket: 5, sessions: 1, bytes: 1_000_000_000),
        ]
        let bySessions = TimelineAggregator().aggregate(
            rows, selection: VisualizationSelection(scale: .day, metric: .sessions, end: anchor)
        )
        let byBytes = TimelineAggregator().aggregate(
            rows, selection: VisualizationSelection(scale: .day, metric: .bytes, end: anchor)
        )
        XCTAssertEqual(bySessions.series.first?.name, "Beacon")
        XCTAssertEqual(byBytes.series.first?.name, "Uploader")
    }

    func testUnmeasuredBytesAreReportedInsteadOfDrawnAsQuietPeriods() {
        let model = TimelineAggregator().aggregate([
            row("Safari", bucket: 1, sessions: 9, bytes: 0, withoutBytes: 9),
        ], selection: VisualizationSelection(scale: .day, metric: .bytes, end: anchor))

        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.observationsWithoutBytes, 9)
        XCTAssertTrue(model.byteCoverageIsPartial, "the screen can explain the blank chart")
    }

    func testOutOfRangeBucketsAreIgnoredRatherThanCrashing() {
        let model = TimelineAggregator().aggregate([
            row("Safari", bucket: -1, sessions: 5),
            row("Safari", bucket: 999, sessions: 5),
            row("Safari", bucket: 0, sessions: 2),
        ], selection: selection)
        XCTAssertEqual(model.total, 2)
    }

    func testStackedTotalsAddUpPerBucket() {
        let model = TimelineAggregator().aggregate([
            row("Safari", bucket: 3, sessions: 4),
            row("Mail", bucket: 3, sessions: 6),
            row("Mail", bucket: 4, sessions: 1),
        ], selection: selection)
        XCTAssertEqual(model.bucketTotals[3], 10)
        XCTAssertEqual(model.bucketTotals[4], 1)
        XCTAssertEqual(model.bucketTotals.reduce(0, +), model.total)
    }

    func testTheLegendKeepsItsOrderBetweenRefreshes() {
        let rows = [
            row("A", bucket: 1, sessions: 5),
            row("B", bucket: 2, sessions: 5),
            row("C", bucket: 3, sessions: 5),
        ]
        let first = TimelineAggregator().aggregate(rows, selection: selection)
        let second = TimelineAggregator().aggregate(rows.reversed(), selection: selection)
        XCTAssertEqual(first.series.map(\.name), second.series.map(\.name))
    }

    func testAnEmptyPeriodStillDescribesItself() {
        let model = TimelineAggregator().aggregate([], selection: selection)
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.bucketStarts.count, VisualizationSelection.bucketCount)
        let summary = model.accessibilitySummary(
            empty: "No traffic in this period.",
            headline: { _, _, _ in "unused" },
            busiest: { _, _, _ in "unused" }
        )
        XCTAssertEqual(summary, "No traffic in this period.")
    }

    func testTheSummaryNamesTheBusiestApplicationAndWhen() {
        let model = TimelineAggregator().aggregate([
            row("Safari", bucket: 2, sessions: 70),
            row("Mail", bucket: 9, sessions: 30),
        ], selection: selection)

        let summary = model.accessibilitySummary(
            empty: "empty",
            headline: { count, total, _ in "\(count) apps, \(Int(total)) sessions." },
            busiest: { app, share, _ in "\(app) is \(share) percent." }
        )
        XCTAssertEqual(summary, "2 apps, 100 sessions. Safari is 70 percent.")
    }
}

final class TimelineStoreQueryTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-timeline-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func observation(app: String, at: Date, bytes: UInt64?) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
            remoteAddress: "203.0.113.5", remotePort: 443, processID: 501, processName: app,
            bundleID: nil, firstObservedAt: at, lastObservedAt: at,
            bytesIn: bytes, bytesOut: bytes, collector: .networkExtension, confidence: .exact
        )
    }

    func testObservationsLandInTheBucketThatCoversTheirTime() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let start = anchor.addingTimeInterval(-3_600)
        // 60 buckets over an hour: one minute each.
        try store.append([
            observation(app: "Safari", at: start.addingTimeInterval(30), bytes: 10),
            observation(app: "Safari", at: start.addingTimeInterval(90), bytes: 10),
            observation(app: "Mail", at: start.addingTimeInterval(90), bytes: nil),
        ])

        let rows = try store.appTimeline(from: start, to: anchor, buckets: 60)
        XCTAssertEqual(rows.first { $0.processName == "Safari" && $0.bucketIndex == 0 }?.sessionCount, 1)
        XCTAssertEqual(rows.first { $0.processName == "Safari" && $0.bucketIndex == 1 }?.sessionCount, 1)
        XCTAssertEqual(rows.first { $0.processName == "Mail" }?.observationsWithoutBytes, 1)
    }

    func testTheFinalInstantDoesNotFallOffTheEnd() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let start = anchor.addingTimeInterval(-3_600)
        try store.append([observation(app: "Safari", at: anchor.addingTimeInterval(-0.5), bytes: 1)])
        let rows = try store.appTimeline(from: start, to: anchor, buckets: 60)
        XCTAssertEqual(rows.first?.bucketIndex, 59, "the last bucket, not one past the end")
    }

    func testAnEmptyWindowReturnsNothingRatherThanFailing() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        XCTAssertEqual(try store.appTimeline(from: anchor, to: anchor, buckets: 60).count, 0)
    }
}
