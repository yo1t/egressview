import XCTest
@testable import EgressViewAgentCore

/// The destination-name card on the overview (P3-162). Its denominator has to
/// be the destinations the chart under it draws, or the card and the chart
/// disagree in front of the reader.
final class DestinationNameCoverageTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!

    /// Hour-aligned, so the folded hour and the raw rows either side of it are
    /// unambiguous.
    private let hour = Date(timeIntervalSince1970: 1_699_999_200)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("name-coverage-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(
        at date: Date, address: String, hostname: String?, process: String = "curl", port: UInt16 = 1
    ) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: port,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: date, lastObservedAt: date,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: hostname
        )])
    }

    func test_名前のある宛先と無い宛先を宛先単位で数える() throws {
        try observe(at: hour.addingTimeInterval(60), address: "203.0.113.1", hostname: "one.example")
        try observe(at: hour.addingTimeInterval(120), address: "203.0.113.2", hostname: nil)
        try observe(at: hour.addingTimeInterval(180), address: "203.0.113.3", hostname: "three.example")

        let coverage = try store.destinationNameCoverage(from: hour, to: hour.addingTimeInterval(1800))

        XCTAssertEqual(coverage.named, 2)
        XCTAssertEqual(coverage.total, 3)
    }

    /// Every destination with one connection makes "named destinations" and
    /// "named connections" the same number, and a mutation that counts the
    /// wrong one survives -- which is what happened on Windows. A second
    /// connection to a named destination separates the two answers.
    func test_接続数での割合は宛先の割合と別に数える() throws {
        try observe(at: hour.addingTimeInterval(60), address: "203.0.113.1", hostname: "one.example", port: 1)
        try observe(at: hour.addingTimeInterval(90), address: "203.0.113.1", hostname: "one.example", port: 2)
        try observe(at: hour.addingTimeInterval(120), address: "192.168.1.10", hostname: nil, port: 3)
        try observe(at: hour.addingTimeInterval(150), address: "192.168.1.10", hostname: nil, port: 4)
        try observe(at: hour.addingTimeInterval(180), address: "192.168.1.10", hostname: nil, port: 5)
        try observe(at: hour.addingTimeInterval(210), address: "192.168.1.10", hostname: nil, port: 6)

        let coverage = try store.destinationNameCoverage(from: hour, to: hour.addingTimeInterval(1800))

        XCTAssertEqual(coverage.named, 1)
        XCTAssertEqual(coverage.total, 2)
        XCTAssertEqual(coverage.namedConnections, 2)
        XCTAssertEqual(coverage.connections, 6)
        XCTAssertEqual(coverage.share, 0.5)
        XCTAssertEqual(try XCTUnwrap(coverage.connectionShare), 2.0 / 6.0, accuracy: 1e-9)
    }

    /// The address written out again is not a name, and neither is another
    /// address or a blank. Counting them would read 100% on a Mac that
    /// resolved nothing.
    func test_アドレスや空白は名前として数えない() throws {
        try observe(at: hour.addingTimeInterval(60), address: "203.0.113.1", hostname: "203.0.113.1")
        try observe(at: hour.addingTimeInterval(120), address: "203.0.113.2", hostname: "198.51.100.9")
        try observe(at: hour.addingTimeInterval(180), address: "2001:db8::1", hostname: "2001:DB8::1")
        try observe(at: hour.addingTimeInterval(240), address: "203.0.113.4", hostname: "   ")

        let coverage = try store.destinationNameCoverage(from: hour, to: hour.addingTimeInterval(1800))

        XCTAssertEqual(coverage.named, 0)
        XCTAssertEqual(coverage.total, 4)
        XCTAssertEqual(coverage.namedConnections, 0)
    }

    /// One address seen with a name and without one is a named destination,
    /// once. Its unnamed connection is still unnamed: the per-connection share
    /// is about what each connection carried.
    func test_同じ宛先に名前ありと無しがあれば宛先は名前あり一件() throws {
        try observe(at: hour.addingTimeInterval(60), address: "203.0.113.1", hostname: "one.example", port: 1)
        try observe(at: hour.addingTimeInterval(120), address: "203.0.113.1", hostname: nil, port: 2)
        try observe(at: hour.addingTimeInterval(180), address: "203.0.113.1", hostname: "alias.example", port: 3)

        let coverage = try store.destinationNameCoverage(from: hour, to: hour.addingTimeInterval(1800))

        XCTAssertEqual(coverage.named, 1)
        XCTAssertEqual(coverage.total, 1)
        XCTAssertEqual(coverage.namedConnections, 2)
        XCTAssertEqual(coverage.connections, 3)
    }

    /// A folded hour is read from the aggregate and the hour in progress from
    /// the raw rows. The raw rows of the folded hour still exist until
    /// retention removes them, so reading both would count them twice.
    func test_畳んだ時間と進行中の時間を二重に数えない() throws {
        try observe(at: hour.addingTimeInterval(600), address: "203.0.113.1", hostname: "folded.example", port: 1)
        try observe(at: hour.addingTimeInterval(700), address: "203.0.113.2", hostname: nil, port: 2)
        try observe(at: hour.addingTimeInterval(3600 + 600), address: "203.0.113.1", hostname: "folded.example", port: 3)
        try observe(at: hour.addingTimeInterval(3600 + 700), address: "203.0.113.3", hostname: "after.example", port: 4)
        let now = hour.addingTimeInterval(3600 + 1200)
        try store.foldCompletedHoursForCharts(now: now)

        let coverage = try store.destinationNameCoverage(from: hour, to: now)

        XCTAssertEqual(coverage.total, 3)
        XCTAssertEqual(coverage.named, 2)
        XCTAssertEqual(coverage.connections, 4)
        XCTAssertEqual(coverage.namedConnections, 3)
    }

    /// The card's population is the chart's. Asked of the same period, the
    /// chart grouped by address and the card name the same destinations and
    /// the same number of connections.
    func test_分母はサンキー図の宛先と接続数に一致する() throws {
        try observe(at: hour.addingTimeInterval(-1200), address: "203.0.113.1", hostname: "before.example", port: 1)
        try observe(at: hour.addingTimeInterval(600), address: "203.0.113.2", hostname: nil, process: "a", port: 2)
        try observe(at: hour.addingTimeInterval(700), address: "203.0.113.2", hostname: nil, process: "b", port: 3)
        try observe(at: hour.addingTimeInterval(3600 + 600), address: "203.0.113.3", hostname: "after.example", port: 4)
        let from = hour.addingTimeInterval(-1800)
        let now = hour.addingTimeInterval(3600 + 1200)
        try store.foldCompletedHoursForCharts(now: now)

        let chart = try store.appDestinationTotals(from: from, to: now, grouping: .address)
        let coverage = try store.destinationNameCoverage(from: from, to: now)

        XCTAssertEqual(coverage.total, Set(chart.map(\.destination)).count)
        XCTAssertEqual(coverage.connections, chart.reduce(0) { $0 + $1.sessionCount })
    }

    /// Zero over zero is not zero. A period with no traffic has no share, and
    /// a screen showing 0% for it would report a fault that does not exist.
    func test_通信の無い期間は割合を出さない() throws {
        let coverage = try store.destinationNameCoverage(from: hour, to: hour.addingTimeInterval(1800))

        XCTAssertEqual(coverage, .empty)
        XCTAssertNil(coverage.share)
        XCTAssertNil(coverage.connectionShare)
    }

    func test_名前として使えるか() {
        XCTAssertTrue(DestinationName.isUsable("api.example", for: "203.0.113.1"))
        XCTAssertTrue(DestinationName.isUsable("1e100.net", for: "203.0.113.1"))
        XCTAssertFalse(DestinationName.isUsable(nil, for: "203.0.113.1"))
        XCTAssertFalse(DestinationName.isUsable("", for: "203.0.113.1"))
        XCTAssertFalse(DestinationName.isUsable("203.0.113.1", for: "203.0.113.1"))
        XCTAssertFalse(DestinationName.isUsable("198.51.100.1", for: "203.0.113.1"))
        XCTAssertFalse(DestinationName.isUsable("fe80::1", for: "203.0.113.1"))
    }
}
