import Foundation
import XCTest
@testable import EgressViewAgentCore

private let base = Date(timeIntervalSince1970: 1_800_000_000)

private func connection(
    opened: TimeInterval, ended: TimeInterval, bytes: UInt64?,
    collector: CollectorKind = .networkExtension
) -> ConnectionObservation {
    ConnectionObservation(
        networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: 49_152,
        remoteAddress: "203.0.113.5", remotePort: 443, processID: 501,
        processName: "Safari", bundleID: nil,
        firstObservedAt: base.addingTimeInterval(opened),
        lastObservedAt: base.addingTimeInterval(ended),
        bytesIn: bytes, bytesOut: bytes.map { _ in 1 },
        collector: collector, confidence: .exact, flowID: UUID()
    )
}

final class ConnectionLogEventTests: XCTestCase {
    func test開始と終了が起きた順に新しい方から並ぶ() {
        let a = connection(opened: 0, ended: 30, bytes: 10)
        let b = connection(opened: 10, ended: 20, bytes: 5)
        let events = ConnectionLogEvent.events(from: [a, b], since: base, limit: 10)
        XCTAssertEqual(events.map(\.kind), [.ended, .ended, .opened, .opened])
        XCTAssertEqual(events.map { $0.at.timeIntervalSince(base) }, [30, 20, 10, 0])
    }

    func test終了が報告されていない接続は開始だけ() {
        let open = connection(opened: 5, ended: 5, bytes: nil)
        let events = ConnectionLogEvent.events(from: [open], since: base, limit: 10)
        XCTAssertEqual(events.map(\.kind), [.opened], "見ていない終了を作ってはいけない")
    }

    func test期間より前の開始は出さず期間内の終了は出す() {
        let spanning = connection(opened: -60, ended: 30, bytes: 10)
        let events = ConnectionLogEvent.events(from: [spanning], since: base, limit: 10)
        XCTAssertEqual(events.map(\.kind), [.ended])
    }

    func test件数の上限は新しい方を残す() {
        let rows = (0..<5).map { connection(opened: Double($0 * 10), ended: Double($0 * 10 + 5), bytes: 1) }
        let events = ConnectionLogEvent.events(from: rows, since: base, limit: 3)
        XCTAssertEqual(events.map { $0.at.timeIntervalSince(base) }, [45, 40, 35])
    }

    func test同じ時刻なら終了が開始より上に来る() {
        let instant = connection(opened: 7, ended: 7, bytes: 1)
        let events = ConnectionLogEvent.events(from: [instant], since: base, limit: 10)
        XCTAssertEqual(events.map(\.kind), [.ended, .opened])
    }

    func testNetwork_Extension以外の行には終了を作らない() {
        let sampled = connection(opened: 0, ended: 30, bytes: 10, collector: .libproc)
        let events = ConnectionLogEvent.events(from: [sampled], since: base, limit: 10)
        XCTAssertEqual(events.map(\.kind), [.opened])
    }
}
