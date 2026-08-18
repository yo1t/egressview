import XCTest
@testable import EgressViewAgentCore

/// The charts read an hourly aggregate for completed hours and the raw rows for
/// the hour still in progress. The risk in that arrangement is arithmetic:
/// counting an hour twice, or losing the one being folded.
final class ChartAggregateTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!

    /// 12:00 exactly, so "the current hour" is unambiguous.
    /// Hour-aligned on purpose: the aggregate is hourly and the ranges either
    /// side of it are not, so a test that starts mid-hour tests something else.
    private let hour = Date(timeIntervalSince1970: 1_699_999_200)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("chart-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(at date: Date, process: String = "curl", address: String = "203.0.113.7") throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: "one.example"
        )])
    }

    private func sessions(from: Date, to: Date) throws -> Int {
        try store.appDestinationTotals(from: from, to: to).reduce(0) { $0 + $1.sessionCount }
    }

    /// The whole point: an hour that has been folded must not also be counted
    /// from the raw rows it was folded from, which still exist until retention
    /// deletes them.
    func test_畳んだ時間を二重に数えない() throws {
        for i in 0..<5 { try observe(at: hour.addingTimeInterval(Double(i) * 60)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)

        XCTAssertEqual(try sessions(from: hour, to: now), 5)
    }

    func test_進行中の時間は生データから数える() throws {
        try observe(at: hour.addingTimeInterval(60))            // 畳まれる
        try observe(at: hour.addingTimeInterval(3600 + 60))     // 進行中
        let now = hour.addingTimeInterval(3600 + 120)
        try store.foldCompletedHoursForCharts(now: now)

        XCTAssertEqual(try sessions(from: hour, to: now), 2)
    }

    /// Folding twice must not double the totals: the watermark is what stops it.
    func test_二度畳んでも合計は変わらない() throws {
        for i in 0..<3 { try observe(at: hour.addingTimeInterval(Double(i) * 60)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)
        try store.foldCompletedHoursForCharts(now: now)

        XCTAssertEqual(try sessions(from: hour, to: now), 3)
    }

    func test_進行中の時間は畳まない() throws {
        try observe(at: hour.addingTimeInterval(60))
        // Half an hour in: the hour is not over.
        try store.foldCompletedHoursForCharts(now: hour.addingTimeInterval(1800))
        XCTAssertEqual(try store.chartFoldWatermark().timeIntervalSince1970,
                       hour.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(try sessions(from: hour, to: hour.addingTimeInterval(1800)), 1)
    }

    /// The aggregate keeps the hostname, which `hourly_rollup` drops. Without
    /// it, grouping by name would stop working for anything but the last hour.
    func test_畳んでも名前で集計できる() throws {
        try observe(at: hour.addingTimeInterval(60))
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)

        let byName = try store.appDestinationTotals(from: hour, to: now, grouping: .name)
        XCTAssertEqual(byName.first?.destination, "one.example")
        let byAddress = try store.appDestinationTotals(from: hour, to: now, grouping: .address)
        XCTAssertEqual(byAddress.first?.destination, "203.0.113.7")
    }

    func test_時系列も二重に数えない() throws {
        for i in 0..<4 { try observe(at: hour.addingTimeInterval(Double(i) * 60)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)

        let total = try store.appTimeline(from: hour, to: now, buckets: 2)
            .reduce(0) { $0 + $1.sessionCount }
        XCTAssertEqual(total, 4)
    }

    func test_globeも二重に数えない() throws {
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.7", latitude: 35, longitude: 139, countryCode: "JP", city: nil),
        ])
        for i in 0..<6 { try observe(at: hour.addingTimeInterval(Double(i) * 60)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)

        let located = try store.destinationLocations(from: hour, to: now)
        XCTAssertEqual(located.placed.first?.sessionCount, 6)
        XCTAssertEqual(located.unplacedSessions, 0)
    }

    func test_何も無ければ畳んでも安全() throws {
        XCTAssertNoThrow(try store.foldCompletedHoursForCharts(now: hour.addingTimeInterval(3600)))
        XCTAssertEqual(try sessions(from: hour, to: hour.addingTimeInterval(3600)), 0)
    }

    /// The period almost never lines up with the hour: "the last 24 hours" ends
    /// wherever now happens to be. Reading the aggregate by `hour_start >= from`
    /// dropped the part-hour at the start and swallowed the whole hour at the
    /// end -- an error of up to an hour at each edge, which is nothing across a
    /// month and everything across an hour.
    func test_時刻境界に揃っていない期間でも数が合う() throws {
        // 09:30, 10:30, 11:30 -- three hours, none of them aligned.
        try observe(at: hour.addingTimeInterval(1800))
        try observe(at: hour.addingTimeInterval(3600 + 1800))
        try observe(at: hour.addingTimeInterval(7200 + 1800))
        let now = hour.addingTimeInterval(10800)
        try store.foldCompletedHoursForCharts(now: now)

        // From 09:15 to now: all three are inside.
        XCTAssertEqual(try sessions(from: hour.addingTimeInterval(900), to: now), 3)
        // From 10:00: the first is outside.
        XCTAssertEqual(try sessions(from: hour.addingTimeInterval(3600), to: now), 2)
        // From 10:45: only the 11:30 one. The 10:30 one is before the start,
        // and the aggregate must not round it back in.
        XCTAssertEqual(try sessions(from: hour.addingTimeInterval(3600 + 2700), to: now), 1)
        // A window ending mid-hour excludes what came after it.
        XCTAssertEqual(
            try sessions(from: hour, to: hour.addingTimeInterval(3600 + 900)), 1
        )
    }

    /// A window entirely inside one unfinished hour is answered from the raw
    /// rows alone, and must not be rounded to the hour.
    func test_1時間の内側だけを見る期間() throws {
        try observe(at: hour.addingTimeInterval(600))
        try observe(at: hour.addingTimeInterval(2400))
        try store.foldCompletedHoursForCharts(now: hour.addingTimeInterval(3000))

        XCTAssertEqual(
            try sessions(from: hour.addingTimeInterval(1200), to: hour.addingTimeInterval(3000)), 1
        )
    }
}
