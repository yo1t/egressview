import Foundation
import SQLite3
import SwiftUI
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewAgentUI

/// The overview's anomaly tile explains each anomaly on hover. What explains
/// one -- the usual level and who sent it -- is known only when it is found,
/// so it is kept with the window then (schema 17).
final class OutboundAnomalyBreakdownTests: XCTestCase {
    private var directory: URL!
    private let window = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-anomaly-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private var url: URL { directory.appendingPathComponent("history.sqlite") }

    private func observation(process: String, remote: String, at: Date, bytesOut: UInt64) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
            remoteAddress: remote, remotePort: 443, processID: 501, processName: process,
            bundleID: nil, firstObservedAt: at, lastObservedAt: at,
            bytesIn: 10, bytesOut: bytesOut, collector: .networkExtension, confidence: .exact
        )
    }

    /// Captures `start`'s window with one connection in it and flags it.
    private func flag(_ store: ObservationStore, _ start: Date, kind: OutboundAnomalyKind = .largeTransfer) throws {
        try store.append([observation(process: "Safari", remote: "203.0.113.5",
                                      at: start.addingTimeInterval(30), bytesOut: 500)])
        _ = try XCTUnwrap(store.captureOutboundTrafficWindow(now: start.addingTimeInterval(901)))
        try store.recordOutboundAnomaly(windowStart: start, kind: kind)
    }

    private let breakdown = OutboundAnomalyRecord.Breakdown(
        usualBytesOut: 120,
        applications: [.init(name: "Safari", bytesOut: 500)],
        destinations: [.init(name: "upload.example", bytesOut: 500)],
        sendingDestinationCount: 3
    )

    func test内訳は窓と一緒に残り再起動後も読める() throws {
        do {
            let store = try ObservationStore(fileURL: url)
            try flag(store, window)
            try store.recordOutboundAnomalyBreakdown(windowStart: window, breakdown: breakdown)
        }
        let reopened = try ObservationStore(fileURL: url)
        let records = try reopened.outboundAnomalies(
            from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
        )
        XCTAssertEqual(records.count, 1)
        XCTAssertEqual(records.first?.kind, .largeTransfer)
        XCTAssertEqual(records.first?.bytesOut, 500)
        XCTAssertEqual(records.first?.breakdown, breakdown)
    }

    func test内訳を持たない古い異常も一覧に出る() throws {
        let store = try ObservationStore(fileURL: url)
        try flag(store, window, kind: .distributedTransfer)
        let records = try store.outboundAnomalies(
            from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
        )
        XCTAssertEqual(records.count, 1)
        XCTAssertNil(records.first?.breakdown, "無い内訳を作らない")
    }

    func test新しい順で件数の上限を守る() throws {
        let store = try ObservationStore(fileURL: url)
        for index in 0..<7 {
            try flag(store, window.addingTimeInterval(Double(index) * 900))
        }
        let records = try store.outboundAnomalies(
            from: window, to: window.addingTimeInterval(7 * 900), limit: 5
        )
        XCTAssertEqual(records.count, 5)
        XCTAssertEqual(records.first?.windowStart, window.addingTimeInterval(6 * 900))
        XCTAssertEqual(records.map(\.windowStart), records.map(\.windowStart).sorted(by: >))
    }

    func test異常でない窓は出ない() throws {
        let store = try ObservationStore(fileURL: url)
        try store.append([observation(process: "Safari", remote: "203.0.113.5",
                                      at: window.addingTimeInterval(30), bytesOut: 500)])
        _ = try store.captureOutboundTrafficWindow(now: window.addingTimeInterval(901))
        XCTAssertTrue(try store.outboundAnomalies(
            from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
        ).isEmpty)
    }

    func test16から17への移行で既存の異常が残る() throws {
        do {
            let store = try ObservationStore(fileURL: url)
            try flag(store, window)
        }
        // Back to 16, as a Mac on 0.5.96 has it.
        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        XCTAssertEqual(sqlite3_exec(database, """
            ALTER TABLE outbound_traffic_windows DROP COLUMN anomaly_breakdown;
            PRAGMA user_version=16;
            """, nil, nil, nil), SQLITE_OK)
        sqlite3_close(database)

        let reopened = try ObservationStore(fileURL: url)
        XCTAssertEqual(reopened.schemaVersion(), ObservationStore.latestSchemaVersion)
        let records = try reopened.outboundAnomalies(
            from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
        )
        XCTAssertEqual(records.count, 1)
        XCTAssertNil(records.first?.breakdown)
        try reopened.recordOutboundAnomalyBreakdown(windowStart: window, breakdown: breakdown)
        XCTAssertEqual(try reopened.outboundAnomalies(
            from: window.addingTimeInterval(-1), to: window.addingTimeInterval(900)
        ).first?.breakdown, breakdown)
    }

    func test記録は通知の履歴として符号化して戻せる() throws {
        let record = OutboundAnomalyRecord(
            kind: .distributedTransfer, windowStart: window, bytesOut: 900,
            applicationCount: 4, destinationCount: 20, breakdown: breakdown
        )
        let decoded = try JSONDecoder().decode(
            OutboundAnomalyRecord.self, from: JSONEncoder().encode(record)
        )
        XCTAssertEqual(decoded, record)
    }

    @MainActor
    func test詳細の一覧が描ける() throws {
        AgentStrings.resourceDirectoryOverride = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Xcode/Host")
        let records = [
            OutboundAnomalyRecord(
                kind: .largeTransfer, windowStart: window, bytesOut: 845_600_000,
                applicationCount: 3, destinationCount: 12, breakdown: breakdown
            ),
            OutboundAnomalyRecord(
                kind: .distributedTransfer, windowStart: window.addingTimeInterval(-3_600),
                bytesOut: 210_000_000, applicationCount: 6, destinationCount: 40, breakdown: nil
            ),
        ]
        let view = AgentOutboundAnomalyList(records: records, total: 7)
            .padding(14).frame(width: 400)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.nsImage, "描画できなかった")
        XCTAssertGreaterThan(image.size.height, 200, "内訳と注記の分の高さがある")
        if let path = ProcessInfo.processInfo.environment["EGRESSVIEW_RENDER_OUT"],
           let tiff = image.tiffRepresentation,
           let png = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try png.write(to: URL(fileURLWithPath: path))
        }
    }
}
