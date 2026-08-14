import Foundation
import XCTest
@testable import EgressViewAgentCore

private func row(
    _ app: String,
    _ destination: String,
    sessions: Int,
    bytes: UInt64 = 0,
    withoutBytes: Int = 0
) -> AppDestinationTotal {
    AppDestinationTotal(
        processName: app,
        destination: destination,
        sessionCount: sessions,
        bytes: bytes,
        observationsWithoutBytes: withoutBytes
    )
}

final class SankeyAggregatorTests: XCTestCase {
    func testTheDiagramShowsWhichAppTalksToWhichDestination() {
        let model = SankeyAggregator().aggregate([
            row("Safari", "example.com", sessions: 10),
            row("Safari", "cdn.example.net", sessions: 4),
            row("Mail", "mail.example.com", sessions: 6),
        ], metric: .sessions)

        XCTAssertEqual(model.apps.map(\.name), ["Safari", "Mail"])
        XCTAssertEqual(model.apps.first?.value, 14)
        XCTAssertEqual(model.total, 20)
        XCTAssertEqual(model.links.count, 3)
    }

    func testFoldingKeepsTheTotalSoTheHiddenShareStaysVisible() {
        // 12 destinations, a limit of 3. What is folded away must still be
        // counted, or the picture quietly understates the traffic.
        let rows = (0..<12).map { row("Safari", "host-\($0).example.com", sessions: 12 - $0) }
        let model = SankeyAggregator(limit: 3).aggregate(rows, metric: .sessions)

        XCTAssertEqual(model.total, Double(rows.reduce(0) { $0 + $1.sessionCount }))
        XCTAssertEqual(model.links.map(\.value).reduce(0, +), model.total)
        XCTAssertEqual(model.destinations.filter(\.isRemainder).count, 1)
        XCTAssertEqual(model.destinations.count, 4, "three named destinations plus the remainder")
    }

    func testTheRemainderIsListedLastEvenWhenItIsTheLargest() {
        let rows = [row("Safari", "big.example.com", sessions: 1)]
            + (0..<20).map { row("Safari", "small-\($0).example.com", sessions: 50) }
        let model = SankeyAggregator(limit: 1).aggregate(rows, metric: .sessions)

        XCTAssertTrue(model.destinations.last?.isRemainder == true)
        XCTAssertGreaterThan(
            model.destinations.last?.value ?? 0,
            model.destinations.first?.value ?? 0,
            "a residue is not a participant, however large"
        )
    }

    func testByteAndSessionViewsDisagreeAndBothAreAvailable() {
        // A beacon and an upload. Each is invisible to the other's measure,
        // which is why the metric can be switched.
        let rows = [
            row("Beacon", "telemetry.example.com", sessions: 10_000, bytes: 10_000_000),
            row("Uploader", "storage.example.com", sessions: 1, bytes: 1_000_000_000),
        ]
        let bySessions = SankeyAggregator().aggregate(rows, metric: .sessions)
        let byBytes = SankeyAggregator().aggregate(rows, metric: .bytes)

        XCTAssertEqual(bySessions.apps.first?.name, "Beacon")
        XCTAssertEqual(byBytes.apps.first?.name, "Uploader")
    }

    func testUnmeasuredBytesAreReportedRatherThanDrawnAsZero() {
        // Byte counts arrive when a flow closes, so an open flow has none yet.
        // Zero would read as "sent nothing".
        let model = SankeyAggregator().aggregate([
            row("Safari", "example.com", sessions: 5, bytes: 0, withoutBytes: 5),
            row("Mail", "mail.example.com", sessions: 2, bytes: 4_096, withoutBytes: 0),
        ], metric: .bytes)

        XCTAssertEqual(model.observationsWithoutBytes, 5)
        XCTAssertTrue(model.byteCoverageIsPartial)
        // Safari contributed no measured bytes, so it draws no ribbon at all
        // rather than a zero-width one.
        XCTAssertEqual(model.links.map(\.source), ["Mail"])
    }

    func testTheSessionViewIsNotMarkedAsPartialByMissingBytes() {
        let model = SankeyAggregator().aggregate([
            row("Safari", "example.com", sessions: 5, withoutBytes: 5),
        ], metric: .sessions)
        XCTAssertFalse(model.byteCoverageIsPartial)
        XCTAssertEqual(model.links.count, 1)
    }

    func testAPeriodWithNothingInItProducesAnEmptyDiagram() {
        let model = SankeyAggregator().aggregate([], metric: .bytes)
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.total, 0)
        XCTAssertTrue(model.apps.isEmpty)
    }

    func testAPeriodWithOnlyUnmeasuredBytesIsEmptyButExplains() {
        let model = SankeyAggregator().aggregate([
            row("Safari", "example.com", sessions: 3, bytes: 0, withoutBytes: 3),
        ], metric: .bytes)
        XCTAssertTrue(model.isEmpty)
        XCTAssertEqual(model.observationsWithoutBytes, 3, "the screen can say why it is blank")
    }

    func testIdenticalReadingsProduceTheSameOrder() {
        // A diagram that reshuffles between refreshes is unreadable.
        let rows = [
            row("A", "x.example.com", sessions: 5),
            row("B", "y.example.com", sessions: 5),
            row("C", "z.example.com", sessions: 5),
        ]
        let first = SankeyAggregator().aggregate(rows, metric: .sessions)
        let second = SankeyAggregator().aggregate(rows.reversed(), metric: .sessions)
        XCTAssertEqual(first.apps.map(\.name), second.apps.map(\.name))
        XCTAssertEqual(first.links, second.links)
    }

    func testManyDistinctPairsStillFoldToAReadableSize() {
        // Production scale: one Mac produced over 100,000 observations in a day.
        let rows = (0..<5_000).map {
            row("app-\($0 % 60)", "host-\($0 % 900).example.com", sessions: 1 + $0 % 7)
        }
        let model = SankeyAggregator(limit: 8).aggregate(rows, metric: .sessions)

        XCTAssertLessThanOrEqual(model.apps.count, 9)
        XCTAssertLessThanOrEqual(model.destinations.count, 9)
        XCTAssertLessThanOrEqual(model.links.count, 81)
        XCTAssertEqual(
            model.links.map(\.value).reduce(0, +), model.total,
            "folding must not lose traffic"
        )
    }
}

final class SankeyStoreQueryTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-sankey-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func observation(
        app: String, address: String, hostname: String?, at: Date,
        bytesIn: UInt64?, bytesOut: UInt64?
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
            remoteAddress: address, remotePort: 443, processID: 501, processName: app,
            bundleID: nil, firstObservedAt: at, lastObservedAt: at,
            bytesIn: bytesIn, bytesOut: bytesOut, collector: .networkExtension,
            confidence: .exact, remoteHostname: hostname
        )
    }

    func testTheDestinationIsTheNameWhenThereIsOneAndTheAddressOtherwise() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(app: "Safari", address: "203.0.113.5", hostname: "example.com",
                        at: now, bytesIn: 100, bytesOut: 200),
            observation(app: "curl", address: "203.0.113.9", hostname: nil,
                        at: now, bytesIn: 1, bytesOut: 2),
        ])

        let totals = try store.appDestinationTotals(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(Set(totals.map(\.destination)), ["example.com", "203.0.113.9"])
        XCTAssertEqual(totals.first { $0.processName == "Safari" }?.bytes, 300)
    }

    func testDeletedHistoryDoesNotAppearInTheDiagram() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(app: "Safari", address: "203.0.113.5", hostname: nil,
                        at: now.addingTimeInterval(-7_200), bytesIn: 5, bytesOut: 5),
            observation(app: "Mail", address: "203.0.113.6", hostname: nil,
                        at: now, bytesIn: 5, bytesOut: 5),
        ])
        _ = try store.removeObservations(before: now.addingTimeInterval(-3_600))

        let totals = try store.appDestinationTotals(
            from: now.addingTimeInterval(-86_400), to: now.addingTimeInterval(60)
        )
        XCTAssertEqual(totals.map(\.processName), ["Mail"])
    }

    func testFlowsWithNoByteCountAreCountedSeparately() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([
            observation(app: "Safari", address: "203.0.113.5", hostname: nil,
                        at: now, bytesIn: nil, bytesOut: nil),
            observation(app: "Safari", address: "203.0.113.5", hostname: nil,
                        at: now.addingTimeInterval(1), bytesIn: 10, bytesOut: 20),
        ])

        let totals = try store.appDestinationTotals(
            from: now.addingTimeInterval(-60), to: now.addingTimeInterval(60)
        )
        let safari = try XCTUnwrap(totals.first)
        XCTAssertEqual(safari.sessionCount, 2)
        XCTAssertEqual(safari.bytes, 30, "only the measured flow contributes")
        XCTAssertEqual(safari.observationsWithoutBytes, 1)
    }
}
