import XCTest
@testable import EgressViewAgentCore

/// Individual observations are folded into hourly totals after `rawDays` and
/// then deleted, so the two tables hold **different halves** of the history.
/// Every chart that read only the raw half quietly showed a shorter period than
/// the one the user selected: a month became a fortnight, with nothing saying
/// so.
final class RolledUpHistoryTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!

    private let hour = Date(timeIntervalSince1970: 1_700_000_000)
    private var from: Date { hour.addingTimeInterval(-3600) }
    private var to: Date { hour.addingTimeInterval(7200) }

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rollup-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
        try insertRollup(
            hourStart: hour, process: "olderApp", address: "203.0.113.7",
            sessions: 40, bytesIn: 900, bytesOut: 100
        )
        try store.append([observation(process: "newerApp", address: "198.51.100.9")])
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observation(process: String, address: String) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: hour.addingTimeInterval(3600),
            lastObservedAt: hour.addingTimeInterval(3600),
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: "new.example"
        )
    }

    private func insertRollup(
        hourStart: Date, process: String, address: String,
        sessions: Int, bytesIn: Int, bytesOut: Int
    ) throws {
        try store.insertRolledUpHourForTesting(
            hourStart: hourStart, processName: process, remoteAddress: address,
            sessionCount: sessions, bytesIn: bytesIn, bytesOut: bytesOut
        )
    }

    func test_サンキーは畳まれた履歴も含める() throws {
        let totals = try store.appDestinationTotals(from: from, to: to, grouping: .address)
        let apps = Set(totals.map(\.processName))
        XCTAssertTrue(apps.contains("olderApp"), "畳まれた分が落ちている: \(apps)")
        XCTAssertTrue(apps.contains("newerApp"))
        let older = try XCTUnwrap(totals.first { $0.processName == "olderApp" })
        XCTAssertEqual(older.sessionCount, 40)
        XCTAssertEqual(older.bytes, 1000)
    }

    func test_時系列は畳まれた履歴も含める() throws {
        let buckets = try store.appTimeline(from: from, to: to, buckets: 3)
        let apps = Set(buckets.map(\.processName))
        XCTAssertTrue(apps.contains("olderApp"), "畳まれた分が落ちている: \(apps)")
        XCTAssertTrue(apps.contains("newerApp"))
        XCTAssertEqual(buckets.filter { $0.processName == "olderApp" }.reduce(0) { $0 + $1.sessionCount }, 40)
    }

    func test_globeは畳まれた履歴も含める() throws {
        try store.replaceGeoLocations([
            GeoLocation(ip: "203.0.113.7", latitude: 35, longitude: 139, countryCode: "JP", city: nil),
        ])
        let located = try store.destinationLocations(from: from, to: to)
        XCTAssertEqual(located.placed.count, 1)
        XCTAssertEqual(located.placed.first?.sessionCount, 40, "畳まれた分の件数")
        // The newer observation has no location, so it counts as unplaced.
        XCTAssertEqual(located.unplacedSessions, 1)
    }

    /// The rolled-up half keeps only the address, so a period reaching into it
    /// cannot be grouped by name however the user sets the picker.
    func test_畳まれた履歴には名前が無いのでアドレスで出る() throws {
        let byName = try store.appDestinationTotals(from: from, to: to, grouping: .name)
        let older = try XCTUnwrap(byName.first { $0.processName == "olderApp" })
        XCTAssertEqual(older.destination, "203.0.113.7")
    }

    func test_期間が生データの範囲に収まるなら畳まれた履歴は使わない() throws {
        let recent = hour.addingTimeInterval(3000)
        XCTAssertFalse(
            try store.periodUsesRolledUpHistory(from: recent, to: to, now: to)
        )
    }

    func test_期間が畳まれた範囲へ届くならそう報告する() throws {
        // `now` far enough ahead that the raw window no longer covers `from`.
        let now = hour.addingTimeInterval(40 * 86_400)
        XCTAssertTrue(try store.periodUsesRolledUpHistory(from: from, to: now, now: now))
    }

    func test_畳まれた履歴が無ければ届いていても報告しない() throws {
        let empty = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("rollup-empty-\(UUID().uuidString).sqlite")
        let bare = try ObservationStore(fileURL: empty)
        defer { try? FileManager.default.removeItem(at: empty) }
        let now = hour.addingTimeInterval(40 * 86_400)
        XCTAssertFalse(try bare.periodUsesRolledUpHistory(from: from, to: now, now: now))
    }
}
