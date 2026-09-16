import XCTest
@testable import EgressViewAgentCore

/// Who sent the traffic, and where to (P3-122).
///
/// The first real detection said "845.6 MB against a usual 674 KB" and nothing
/// else. It was a speed test and a film, but the notice gave the reader no way
/// to know that -- the names are the part they can act on.
final class OutboundWindowContributorsTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!
    private let windowStart = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("contributors-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func send(
        _ bytesOut: UInt64, process: String, host: String?, address: String,
        at offset: TimeInterval
    ) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: process, bundleID: nil,
            firstObservedAt: windowStart.addingTimeInterval(offset),
            lastObservedAt: windowStart.addingTimeInterval(offset),
            bytesIn: 1, bytesOut: bytesOut, collector: .networkExtension,
            confidence: .exact, remoteHostname: host
        )])
    }

    func test送った量の多い順に並ぶ() throws {
        try send(900, process: "Chrome", host: "speedtest.example", address: "198.51.100.1", at: 60)
        try send(80, process: "Mail", host: "mail.example", address: "198.51.100.2", at: 120)
        try send(9, process: "Sync", host: nil, address: "198.51.100.3", at: 180)

        let result = try store.outboundWindowContributors(windowStart: windowStart)
        XCTAssertEqual(result.applications.map(\.name), ["Chrome", "Mail", "Sync"])
        XCTAssertEqual(result.applications.first?.bytesOut, 900)
        XCTAssertEqual(
            result.destinations.map(\.name),
            ["speedtest.example", "mail.example", "198.51.100.3"],
            "名前が無い宛先はアドレスで出るべき"
        )
        XCTAssertEqual(result.destinationCount, 3)
    }

    func test同じアプリの複数接続はまとめる() throws {
        try send(400, process: "Chrome", host: "a.example", address: "198.51.100.1", at: 10)
        try send(500, process: "Chrome", host: "b.example", address: "198.51.100.2", at: 20)

        let result = try store.outboundWindowContributors(windowStart: windowStart)
        XCTAssertEqual(result.applications.count, 1)
        XCTAssertEqual(result.applications.first?.bytesOut, 900)
    }

    func test窓の外は数えない() throws {
        try send(100, process: "Inside", host: "a.example", address: "198.51.100.1", at: 800)
        try send(100, process: "After", host: "b.example", address: "198.51.100.2", at: 901)
        try send(100, process: "Before", host: "c.example", address: "198.51.100.3", at: -1)

        let result = try store.outboundWindowContributors(windowStart: windowStart)
        XCTAssertEqual(result.applications.map(\.name), ["Inside"])
    }

    func test受信しかない通信は出さない() throws {
        // The notice is about what left the Mac.
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: "198.51.100.9", remotePort: 443, processID: 1,
            processName: "Downloader", bundleID: nil,
            firstObservedAt: windowStart.addingTimeInterval(30),
            lastObservedAt: windowStart.addingTimeInterval(30),
            bytesIn: 5_000, bytesOut: 0, collector: .networkExtension,
            confidence: .exact, remoteHostname: "big.example"
        )])
        let result = try store.outboundWindowContributors(windowStart: windowStart)
        XCTAssertTrue(result.applications.isEmpty)
        XCTAssertEqual(result.destinationCount, 0)
    }

    func test上位だけを返す() throws {
        for index in 0..<10 {
            try send(
                UInt64(100 - index), process: "App\(index)",
                host: "host\(index).example", address: "198.51.100.\(index + 1)",
                at: TimeInterval(index)
            )
        }
        let result = try store.outboundWindowContributors(windowStart: windowStart, limit: 3)
        XCTAssertEqual(result.applications.count, 3)
        XCTAssertEqual(result.applications.first?.name, "App0")
        XCTAssertEqual(result.destinationCount, 10, "総数は上位に絞らず数える")
    }
}
