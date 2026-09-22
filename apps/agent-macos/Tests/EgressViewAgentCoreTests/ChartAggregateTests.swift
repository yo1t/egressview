import SQLite3
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

    private func observe(
        at date: Date, process: String = "curl", address: String = "203.0.113.7",
        hostname: String = "one.example"
    ) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: hostname
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

    /// The raw rows outside the folded stretch are two ranges: the part-hour
    /// the period opens with, and the tail past the fold watermark. Asked for
    /// as "the period minus the middle", SQLite seeks the whole period and
    /// filters every row in it -- 20 ms against 712,000 rows on a real Mac,
    /// where naming both ranges is 1 ms (P3-149).
    ///
    /// The arithmetic must not change, and that is what this pins: a row in
    /// each of the three stretches, counted once each.
    func test_期間の前後と畳んだ真ん中をそれぞれ一度ずつ数える() throws {
        // Half an hour before the first whole hour: outside the aggregate.
        try observe(at: hour.addingTimeInterval(-1800), address: "203.0.113.1", hostname: "before.example")
        // Inside the hour that gets folded.
        try observe(at: hour.addingTimeInterval(600), address: "203.0.113.2", hostname: "folded.example")
        // Past the watermark, still raw.
        try observe(at: hour.addingTimeInterval(3600 + 600), address: "203.0.113.3", hostname: "after.example")

        let now = hour.addingTimeInterval(3600 + 1200)
        try store.foldCompletedHoursForCharts(now: now)

        XCTAssertEqual(
            try sessions(from: hour.addingTimeInterval(-1800), to: now), 3,
            "3つの区間のどれかが落ちているか、二重に数えられている"
        )
        // Three separate rows, not one summed three times: each stretch is
        // read once and they do not overlap.
        let totals = try store.appDestinationTotals(
            from: hour.addingTimeInterval(-1800), to: now
        )
        XCTAssertEqual(
            Set(totals.map(\.destination)),
            ["before.example", "folded.example", "after.example"],
            "3つの区間のどれかが読まれていない"
        )
        XCTAssertEqual(totals.map(\.sessionCount), [1, 1, 1], "どこかが二重に数えられている")
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

    func test_方向別データ量も畳んだ時間を二重に数えない() throws {
        for i in 0..<3 { try observe(at: hour.addingTimeInterval(Double(i) * 60)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)
        try store.foldCompletedHoursForCharts(now: now)

        let traffic = try store.periodTrafficSummary(from: hour, to: now)
        XCTAssertEqual(traffic.bytesIn, 30)
        XCTAssertEqual(traffic.bytesOut, 60)
        XCTAssertEqual(traffic.observationsWithoutBytes, 0)
    }

    func test_方向別データ量は期間端と進行中の時間を正確に読む() throws {
        try observe(at: hour.addingTimeInterval(600))
        try observe(at: hour.addingTimeInterval(2_400))
        try observe(at: hour.addingTimeInterval(3_600 + 600))
        let now = hour.addingTimeInterval(3_600 + 1_200)
        try store.foldCompletedHoursForCharts(now: now)

        let traffic = try store.periodTrafficSummary(
            from: hour.addingTimeInterval(1_200), to: now
        )
        XCTAssertEqual(traffic.bytesIn, 20)
        XCTAssertEqual(traffic.bytesOut, 40)
    }

    /// Compaction can split one hour between `hourly_rollup` and the raw
    /// table. The v14 migration must combine those disjoint rows rather than
    /// choosing one representation and silently losing the other half.
    func test_v14移行は保持期限境界の生データと時間集計を合算する() throws {
        store = nil
        store = try ObservationStore(
            fileURL: url, retention: ObservationRetention(retentionDays: 30, rawDays: 1)
        )
        try observe(at: hour.addingTimeInterval(600))
        try observe(at: hour.addingTimeInterval(2_400))
        try store.foldCompletedHoursForCharts(now: hour.addingTimeInterval(3_600))
        try store.compact(now: hour.addingTimeInterval(86_400 + 1_800))
        store = nil

        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        XCTAssertEqual(
            sqlite3_exec(
                database,
                "DROP TABLE traffic_hourly; PRAGMA user_version=13;",
                nil, nil, nil
            ),
            SQLITE_OK
        )
        sqlite3_close(database)

        store = try ObservationStore(
            fileURL: url, retention: ObservationRetention(retentionDays: 30, rawDays: 1)
        )
        let traffic = try store.periodTrafficSummary(
            from: hour, to: hour.addingTimeInterval(3_600)
        )
        XCTAssertEqual(traffic.bytesIn, 20)
        XCTAssertEqual(traffic.bytesOut, 40)
    }

    /// The migration fills hours the next fold will compute again from the
    /// same raw rows. Measured on a copy of one Mac's 560,223-row store
    /// (2026-09-14): 694 hours, and the totals matched the sources exactly --
    /// but only because the fold replaces an hour rather than adding to it.
    func test_v14移行の直後に畳んでも二重にならない() throws {
        store = nil
        store = try ObservationStore(
            fileURL: url, retention: ObservationRetention(retentionDays: 30, rawDays: 7)
        )
        try observe(at: hour.addingTimeInterval(600))
        try observe(at: hour.addingTimeInterval(2_400))
        store = nil

        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        XCTAssertEqual(
            sqlite3_exec(
                database, "DROP TABLE traffic_hourly; PRAGMA user_version=13;", nil, nil, nil
            ),
            SQLITE_OK
        )
        sqlite3_close(database)

        store = try ObservationStore(
            fileURL: url, retention: ObservationRetention(retentionDays: 30, rawDays: 7)
        )
        let now = hour.addingTimeInterval(3_600)
        try store.foldCompletedHoursForCharts(now: now)

        let traffic = try store.periodTrafficSummary(from: hour, to: now)
        XCTAssertEqual(traffic.bytesIn, 20, "移行で入れた時間を、畳み込みが足し直した")
        XCTAssertEqual(traffic.bytesOut, 40)
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

final class TimelineBucketWidthTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!
    private let hour = Date(timeIntervalSince1970: 1_699_999_200)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("bucket-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(at date: Date) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: "203.0.113.7", remotePort: 443, processID: 1,
            processName: "curl", bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 1, bytesOut: 1, collector: .networkExtension,
            confidence: .exact, remoteHostname: nil
        )])
    }

    /// An hourly aggregate read into six-minute buckets puts a whole hour into
    /// one of them and leaves the rest empty. On screen that is a row of spikes
    /// with nothing between them, which reads as a Mac that stopped talking.
    func test_バケットが1時間より狭いときは生データで描く() throws {
        // Ten observations spread across one hour, ten minutes apart.
        for i in 0..<6 { try observe(at: hour.addingTimeInterval(Double(i) * 600)) }
        let now = hour.addingTimeInterval(3600)
        try store.foldCompletedHoursForCharts(now: now)

        // Ten buckets of six minutes each.
        let buckets = try store.appTimeline(from: hour, to: now, buckets: 10)
        let occupied = Set(buckets.map(\.bucketIndex))
        XCTAssertEqual(occupied.count, 6, "6分バケットに散らばるべき: \(occupied.sorted())")
        XCTAssertEqual(buckets.reduce(0) { $0 + $1.sessionCount }, 6)
    }

    func test_バケットが1時間以上なら集計表を使っても同じ合計になる() throws {
        for i in 0..<6 { try observe(at: hour.addingTimeInterval(Double(i) * 600)) }
        let now = hour.addingTimeInterval(3600 * 6)
        try store.foldCompletedHoursForCharts(now: now)

        // Six buckets of one hour each.
        let buckets = try store.appTimeline(from: hour, to: now, buckets: 6)
        XCTAssertEqual(buckets.reduce(0) { $0 + $1.sessionCount }, 6)
    }
}
