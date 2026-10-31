import SQLite3
import XCTest
@testable import EgressViewAgentCore

/// Each Agent measures its own machine, an hour at a time, counting only the
/// time it was monitoring (P3-192, P3-193 phase 1). The Windows Agent keeps
/// the same tables by the same keys.
final class OutboundBaselineTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!

    /// 22:00 UTC, hour-aligned so "the hour" is unambiguous.
    private let hour = Date(timeIntervalSince1970: 1_699_999_200)
    /// Late enough that `hour` has settled, early enough that nothing after
    /// it has.
    private var settled: Date { hour.addingTimeInterval(3600 + ObservationStore.baselineSettleDelay) }

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("baseline-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(
        at date: Date, address: String = "203.0.113.7", hostname: String? = "api.one.example",
        process: String = "curl", bundleID: String? = nil, bytesOut: UInt64? = 1_000
    ) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 50_000,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: bundleID,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: bytesOut, collector: .networkExtension,
            confidence: .exact, remoteHostname: hostname
        )])
    }

    /// Monitored for the whole of `hour`.
    private func monitorWholeHour() throws {
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(3600))
    }

    private func rows(_ sql: String) throws -> [[String]] {
        var db: OpaquePointer?
        guard sqlite3_open_v2(url.path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK else {
            throw XCTSkip("could not open the store read-only")
        }
        defer { sqlite3_close_v2(db) }
        var statement: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, sql, -1, &statement, nil), SQLITE_OK, sql)
        defer { sqlite3_finalize(statement) }
        var result: [[String]] = []
        while sqlite3_step(statement) == SQLITE_ROW {
            result.append((0..<sqlite3_column_count(statement)).map { index in
                sqlite3_column_text(statement, index).map { String(cString: $0) } ?? "NULL"
            })
        }
        return result
    }

    func test宛先は測定スクリプトとWindowsと同じ単位で数える() {
        XCTAssertEqual(OutboundBaselineKeys.destination(hostname: "a.cdn.example.com.", address: "203.0.113.5"), "example.com")
        XCTAssertEqual(OutboundBaselineKeys.destination(hostname: "www.shop.co.jp", address: "203.0.113.5"), "shop.co.jp")
        XCTAssertEqual(OutboundBaselineKeys.destination(hostname: "Example.COM", address: "203.0.113.5"), "example.com")
        XCTAssertEqual(OutboundBaselineKeys.destination(hostname: nil, address: "2001:DB8::1"), "2001:db8::1")
        XCTAssertEqual(OutboundBaselineKeys.destination(hostname: "", address: "203.0.113.5"), "203.0.113.5")
        XCTAssertEqual(OutboundBaselineKeys.application(bundleID: "com.example.app", processName: "app"), "com.example.app")
        XCTAssertEqual(OutboundBaselineKeys.application(bundleID: nil, processName: "curl"), "curl")
        XCTAssertEqual(OutboundBaselineKeys.application(bundleID: " ", processName: ""), "(unknown)")
    }

    func test完了した1時間をインターネット宛てだけで数える() throws {
        try monitorWholeHour()
        try observe(at: hour.addingTimeInterval(60), bytesOut: 1_000)
        try observe(at: hour.addingTimeInterval(120), hostname: "img.one.example", bytesOut: 500)
        try observe(at: hour.addingTimeInterval(180), address: "198.51.100.9", hostname: nil, bytesOut: nil)
        // The LAN stays out, as it does for the fifteen-minute windows: SMB to
        // a NAS was 135 GiB in a week on the development Mac.
        try observe(at: hour.addingTimeInterval(240), address: "192.168.1.20", hostname: "nas.local", bytesOut: 9_000_000)

        XCTAssertGreaterThan(try store.captureBaselineHours(now: settled, maxHours: 1_000), 0)

        let hours = try rows("SELECT monitored_seconds, bytes_out, observations, observations_with_bytes, named_observations FROM baseline_hours")
        XCTAssertEqual(hours, [["3600", "1500", "3", "2", "2"]], "LANが入っているか、数が合わない")
        let days = try rows("SELECT application, destination, bytes_out FROM baseline_pair_days ORDER BY destination")
        XCTAssertEqual(days, [["curl", "one.example", "1500"]], "送信の無い組は日ごとの表に入れない")
        let pairs = try rows("SELECT application, destination FROM baseline_pairs ORDER BY destination")
        XCTAssertEqual(pairs, [["curl", "198.51.100.9"], ["curl", "one.example"]])
    }

    /// One CDN address serves many sites. Keyed by address with one of its
    /// names, every other site's traffic would be filed under that name.
    func test同じアドレスの別の名前は別の宛先として数える() throws {
        try monitorWholeHour()
        try observe(at: hour.addingTimeInterval(60), address: "203.0.113.50", hostname: "www.shop.example", bytesOut: 100)
        try observe(at: hour.addingTimeInterval(120), address: "203.0.113.50", hostname: "cdn.news.example", bytesOut: 200)
        try store.captureBaselineHours(now: settled, maxHours: 1_000)

        XCTAssertEqual(
            try rows("SELECT destination, bytes_out FROM baseline_pair_days ORDER BY destination"),
            [["news.example", "200"], ["shop.example", "100"]]
        )
    }

    func test眠っていた時間は監視した時間に入れない() throws {
        try monitorWholeHour()
        try store.beginSleepPeriod(at: hour.addingTimeInterval(600))
        try store.endSleepPeriod(at: hour.addingTimeInterval(1_500))
        try store.captureBaselineHours(now: settled, maxHours: 1_000)

        XCTAssertEqual(try rows("SELECT monitored_seconds FROM baseline_hours"), [["2700"]])
    }

    func test重なった監視の区間を二重に数えない() throws {
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(2_400))
        // A second session that overlaps the first, as a restore can leave.
        try store.beginCoverageSession(at: hour.addingTimeInterval(1_200))
        try store.endCoverageSession(at: hour.addingTimeInterval(3_000))
        try store.captureBaselineHours(now: settled, maxHours: 1_000)

        XCTAssertEqual(try rows("SELECT monitored_seconds FROM baseline_hours"), [["3000"]])
    }

    func test監視も観測も無い1時間は書かない() throws {
        try store.captureBaselineHours(now: settled, maxHours: 1_000)
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_hours"), [["0"]],
                       "監視していない時間を「通信が無かった」時間として残している")
        XCTAssertEqual(try store.outboundBaselineSummary().hoursRecorded, 0)
    }

    func test再起動しても同じ1時間を二度数えない() throws {
        try monitorWholeHour()
        try observe(at: hour.addingTimeInterval(60))
        try store.captureBaselineHours(now: settled, maxHours: 1_000)
        XCTAssertEqual(try store.captureBaselineHours(now: settled, maxHours: 1_000), 0)

        store = nil
        store = try ObservationStore(fileURL: url)
        XCTAssertEqual(try store.captureBaselineHours(now: settled, maxHours: 1_000), 0)
        XCTAssertEqual(try rows("SELECT bytes_out FROM baseline_pair_days"), [["1000"]])
    }

    func test終わってから2分たつまでその1時間は読まない() throws {
        try monitorWholeHour()
        try observe(at: hour.addingTimeInterval(60))
        try store.captureBaselineHours(now: settled.addingTimeInterval(-1), maxHours: 1_000)
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_hours WHERE hour_start = \(hour.timeIntervalSince1970)"), [["0"]])

        try store.captureBaselineHours(now: settled, maxHours: 1_000)
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_hours WHERE hour_start = \(hour.timeIntervalSince1970)"), [["1"]])
    }

    func test初回は生の記録が残る範囲までさかのぼり1回の上限を守る() throws {
        let now = hour.addingTimeInterval(3600 * 30 + ObservationStore.baselineSettleDelay)
        XCTAssertEqual(try store.captureBaselineHours(now: now, maxHours: 24), 24)
        // Raw history is kept fourteen days, so the first pass starts there.
        let first = try XCTUnwrap(try rows("SELECT captured_through FROM baseline_state").first?.first)
        let expected = (floor((now.timeIntervalSince1970 - 14 * 86_400) / 3600) + 24) * 3600
        XCTAssertEqual(Double(first), expected)
    }

    func test要約は全体を監視できた時間だけで分布を出す() throws {
        // Three fully monitored hours sending 1, 2 and 3 KB, and one hour
        // watched for ten minutes that sent far more.
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(3 * 3600 + 600))
        for index in 0..<3 {
            try observe(at: hour.addingTimeInterval(Double(index) * 3600 + 60), bytesOut: UInt64(index + 1) * 1_000)
        }
        try observe(at: hour.addingTimeInterval(3 * 3600 + 60), bytesOut: 50_000_000)
        let now = hour.addingTimeInterval(4 * 3600 + ObservationStore.baselineSettleDelay)
        try store.captureBaselineHours(now: now, maxHours: 1_000)

        let summary = try store.outboundBaselineSummary()
        XCTAssertEqual(summary.hoursRecorded, 4)
        XCTAssertEqual(summary.fullyMonitoredHours, 3)
        XCTAssertEqual(summary.monitoredHours, 3 + 600.0 / 3600, accuracy: 0.001)
        XCTAssertEqual(summary.hourlyMedianBytesOut, 2_000)
        XCTAssertEqual(summary.largestHourBytesOut, 3_000, "一部しか監視していない時間が分布に入っている")
        XCTAssertEqual(summary.since, hour)
        XCTAssertEqual(summary.pairsKnown, 1)
        XCTAssertEqual(try XCTUnwrap(summary.namedShare), 1, accuracy: 0.001)
    }

    func test消した時間から作られた組の記憶も消す() throws {
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(7_200))
        try observe(at: hour.addingTimeInterval(60), hostname: "early.example")
        try observe(at: hour.addingTimeInterval(3_660), hostname: "early.example")
        try observe(at: hour.addingTimeInterval(3_720), hostname: "late.example")
        try store.captureBaselineHours(now: hour.addingTimeInterval(7_200 + 120), maxHours: 1_000)

        try store.removeObservations(before: hour.addingTimeInterval(3_600))

        XCTAssertEqual(try rows("SELECT destination FROM baseline_pairs ORDER BY destination"), [["late.example"]],
                       "消した時間に初めて見た組が残っている")
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_hours WHERE hour_start < \(hour.timeIntervalSince1970 + 3_600)"), [["0"]])
    }

    func test全部消すと集計も消え古い時間を読み直さない() throws {
        try monitorWholeHour()
        try observe(at: hour.addingTimeInterval(60))
        try store.captureBaselineHours(now: settled, maxHours: 1_000)

        try store.removeAll()

        XCTAssertEqual(try rows("SELECT (SELECT COUNT(*) FROM baseline_hours) + (SELECT COUNT(*) FROM baseline_pair_days) + (SELECT COUNT(*) FROM baseline_pairs)"), [["0"]])
        XCTAssertEqual(try store.outboundBaselineSummary(), OutboundBaselineSummary())
    }

    func test保持期間を過ぎた分は消し後も見た組は初見をずらして残す() throws {
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(7_200))
        try observe(at: hour.addingTimeInterval(60), hostname: "kept.example")
        try observe(at: hour.addingTimeInterval(3_660), hostname: "kept.example")
        try observe(at: hour.addingTimeInterval(120), hostname: "gone.example")
        try store.captureBaselineHours(now: hour.addingTimeInterval(7_200 + 120), maxHours: 1_000)

        // Retention of one day, run so that the cutoff falls between the two hours.
        store.setRetention(ObservationRetention(retentionDays: 1, rawDays: 1))
        try store.compact(now: hour.addingTimeInterval(3_600 + 86_400))

        let cutoff = hour.addingTimeInterval(3_600).timeIntervalSince1970
        XCTAssertEqual(try rows("SELECT destination, first_seen = \(cutoff) FROM baseline_pairs"), [["kept.example", "1"]])
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_hours WHERE hour_start < \(cutoff)"), [["0"]])
    }

    func test組の数は上限を超えたら古い順に忘れる() throws {
        try store.beginCoverageSession(at: hour)
        try store.endCoverageSession(at: hour.addingTimeInterval(7_200))
        try observe(at: hour.addingTimeInterval(60), hostname: "oldest.example")
        let later = hour.addingTimeInterval(3_660)
        try store.append((0..<ObservationStore.baselinePairCapacity).map { index in
            ConnectionObservation(
                // A port each, so the rows are separate connections.
                networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: UInt16(index + 1),
                remoteAddress: "203.0.113.7", remotePort: 443, processID: 1, processName: "curl",
                firstObservedAt: later, lastObservedAt: later, bytesOut: 1,
                collector: .networkExtension, confidence: .exact, remoteHostname: "h\(index).example"
            )
        })
        try store.captureBaselineHours(now: hour.addingTimeInterval(7_200 + 120), maxHours: 1_000)

        XCTAssertEqual(try store.outboundBaselineSummary().pairsKnown, ObservationStore.baselinePairCapacity)
        XCTAssertEqual(try rows("SELECT COUNT(*) FROM baseline_pairs WHERE destination = 'oldest.example'"), [["0"]],
                       "最後に見たのが一番古い組から忘れていない")
    }

    func test診断には数だけを出し名前は出さない() {
        let usual = OutboundBaselineSummary(
            monitoredHours: 12.5, hoursRecorded: 14, fullyMonitoredHours: 11,
            since: Date(timeIntervalSince1970: 1_769_000_000),
            hourlyMedianBytesOut: 13_000_000, hourlyP99BytesOut: 57_000_000,
            largestHourBytesOut: 73_000_000, namedShare: 0.825, bytesShare: 0.99, pairsKnown: 1_007
        )
        let report = AgentDiagnosticsReport(.init(
            generatedAt: Date(timeIntervalSince1970: 1_770_000_000), appVersion: "0.5.137",
            appBuild: "216", osVersion: "27.2", extensionState: "running",
            bundledExtensionVersion: nil, runningExtensionVersion: nil, monitoringEnabled: true,
            health: "healthy", lastObservationAt: nil,
            storage: ObservationStorageSummary(
                rawObservationCount: 1, rolledUpHourCount: 0, chartHourCount: 0,
                threatIndicatorCount: 0, oldestObservationAt: nil, newestObservationAt: nil
            ),
            isEnrolledWithHub: false, deliveryEnabled: false, pendingDeliveryCount: 0,
            oldestPendingAt: nil, lastAcknowledgedAt: nil, unreadableStateResetAt: nil,
            threatIntelSource: "directDownload", outboundBaseline: usual, installLog: .absent
        )).render()

        XCTAssertTrue(report.contains("== Usual outbound traffic"))
        XCTAssertTrue(report.contains("monitored hours   12.5"), report)
        XCTAssertTrue(report.contains("fully monitored   11"))
        XCTAssertTrue(report.contains("per hour median   13000000 bytes"))
        XCTAssertTrue(report.contains("with a name       82.5%"))
        XCTAssertTrue(report.contains("pairs known       1007"))
    }
}
