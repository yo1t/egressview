import XCTest
@testable import EgressViewAgentCore

/// The same cases the Windows Agent is held to, so the two cannot drift apart
/// unnoticed (P3-192, P3-193 phase 2).
final class OutboundCandidateContractTests: XCTestCase {
    private typealias Rules = OutboundCandidateRules
    private static let origin: Double = 1_699_920_000

    private struct Document: Decodable { let cases: [Case] }
    private struct Case: Decodable {
        struct Hours: Decodable {
            let startHour, count, monitoredSeconds, observations, observationsWithBytes: Int
            let bytesOut: UInt64
        }
        struct Day: Decodable {
            let day: Int
            let application, destination: String
            let bytesOut: UInt64?
        }
        struct Candidate: Decodable, Equatable {
            let kind: String
            let day: Int
            let application, destination: String?
            let bytesOut: UInt64
            let usualBytesOut: UInt64?
        }
        struct Expected: Decodable {
            let state: String
            let monitoredHours: Double?
            let byteCoverageShare: Double?
            let total: Int
            let candidates: [Candidate]
        }
        let name: String
        let hours: [Hours]
        let pairDays, firstSeen: [Day]
        let nowDay: Int
        let expected: Expected
    }

    private func time(day: Int) -> Double { Self.origin + Double(day) * 86_400 }

    func testEveryCaseGivesTheSharedResult() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("test/fixtures/outbound-candidates-cases.json")
        let document = try JSONDecoder().decode(Document.self, from: Data(contentsOf: file))
        XCTAssertFalse(document.cases.isEmpty)
        for item in document.cases {
            let hours = item.hours.flatMap { run in
                (0..<run.count).map { offset in
                    Rules.Hour(
                        start: Self.origin + Double(run.startHour + offset) * 3600,
                        monitoredSeconds: run.monitoredSeconds, bytesOut: run.bytesOut,
                        observations: run.observations, observationsWithBytes: run.observationsWithBytes
                    )
                }
            }
            let days = item.pairDays.map {
                Rules.PairDay(
                    day: time(day: $0.day),
                    pair: Rules.PairKey(application: $0.application, destination: $0.destination),
                    bytesOut: $0.bytesOut ?? 0
                )
            }
            let firstSeen = Dictionary(uniqueKeysWithValues: item.firstSeen.map {
                (Rules.PairKey(application: $0.application, destination: $0.destination), time(day: $0.day))
            })
            let report = Rules.evaluate(
                hours: hours, pairDays: days, firstSeen: firstSeen,
                now: Date(timeIntervalSince1970: time(day: item.nowDay))
            )
            switch report.state {
            case .learning(let monitored):
                XCTAssertEqual(item.expected.state, "learning", item.name)
                XCTAssertEqual(item.expected.monitoredHours, monitored, item.name)
            case .lowByteCoverage(let share):
                XCTAssertEqual(item.expected.state, "lowByteCoverage", item.name)
                XCTAssertEqual(item.expected.byteCoverageShare ?? -1, share, accuracy: 0.0001, item.name)
            case .ready:
                XCTAssertEqual(item.expected.state, "ready", item.name)
            }
            XCTAssertEqual(report.total, item.expected.total, item.name)
            let found = report.candidates.map {
                Case.Candidate(
                    kind: $0.kind.rawValue,
                    day: Int(($0.at.timeIntervalSince1970 - Self.origin) / 86_400),
                    application: $0.application, destination: $0.destination,
                    bytesOut: $0.bytesOut, usualBytesOut: $0.usualBytesOut
                )
            }
            XCTAssertEqual(found, item.expected.candidates, item.name)
        }
    }
}
