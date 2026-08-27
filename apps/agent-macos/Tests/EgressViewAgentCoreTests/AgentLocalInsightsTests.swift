import XCTest
@testable import EgressViewAgentCore

final class AgentLocalInsightsTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_700_000_000)

    func testBuildsCurrentAndPreviousCountsWithoutRawObservations() throws {
        let snapshot = try AgentLocalInsightBuilder.build(
            current: [
                row(app: "Browser", destination: "example.com", sessions: 7, bytes: 900),
                row(app: "Browser", destination: "cdn.example.com", sessions: 3, bytes: 100),
                row(app: "Sync", destination: "sync.example", sessions: 2, bytes: 40, unknown: 1),
            ],
            previous: [row(app: "Browser", destination: "example.com", sessions: 4, bytes: 80)],
            periodStart: start,
            periodEnd: start.addingTimeInterval(3_600),
            generatedAt: start.addingTimeInterval(3_601)
        )

        XCTAssertEqual(snapshot.context.current.connections, 12)
        XCTAssertEqual(snapshot.context.current.applications, 2)
        XCTAssertEqual(snapshot.context.current.destinations, 3)
        XCTAssertEqual(snapshot.context.current.measuredBytes, 1_040)
        XCTAssertEqual(snapshot.context.current.connectionsWithoutBytes, 1)
        XCTAssertEqual(snapshot.context.previous.connections, 4)
        XCTAssertEqual(snapshot.context.topApplications.first?.name, "Browser")
        XCTAssertGreaterThan(snapshot.previewSizeBytes, 0)

        let preview = String(decoding: try snapshot.context.encodedPreview(), as: UTF8.self)
        XCTAssertTrue(preview.contains("example.com"))
        XCTAssertFalse(preview.contains("remoteAddress"))
        XCTAssertFalse(preview.contains("processID"))
        XCTAssertFalse(preview.contains("credential"))
        XCTAssertFalse(preview.contains("memo"))
    }

    func testPreviewBoundsApplicationsAndDestinations() throws {
        let rows = (0..<25).map {
            row(app: "app-\($0)", destination: "destination-\($0)", sessions: 25 - $0, bytes: 1)
        }
        let snapshot = try AgentLocalInsightBuilder.build(
            current: rows,
            previous: [],
            periodStart: start,
            periodEnd: start.addingTimeInterval(86_400)
        )

        XCTAssertEqual(snapshot.context.topApplications.count, AgentLocalInsightBuilder.itemLimit)
        XCTAssertEqual(snapshot.context.topDestinations.count, AgentLocalInsightBuilder.itemLimit)
        XCTAssertEqual(snapshot.context.topApplications.first?.name, "app-0")
        XCTAssertEqual(snapshot.context.topApplications.last?.name, "app-9")
    }

    func testSameApplicationIsCombinedBeforeRanking() throws {
        let snapshot = try AgentLocalInsightBuilder.build(
            current: [
                row(app: "Browser", destination: "one.example", sessions: 3, bytes: 20),
                row(app: "Browser", destination: "two.example", sessions: 4, bytes: 30),
            ],
            previous: [],
            periodStart: start,
            periodEnd: start.addingTimeInterval(3_600)
        )

        XCTAssertEqual(
            snapshot.context.topApplications,
            [AgentLocalInsightItem(name: "Browser", connections: 7, measuredBytes: 50)]
        )
    }

    func testPreviewSizeIsBoundedByItemAndNameLimits() throws {
        let longName = String(repeating: "長", count: 2_000)
        let rows = (0..<1_000).map {
            row(
                app: "\(longName)-app-\($0)",
                destination: "\(longName)-destination-\($0)",
                sessions: 1,
                bytes: 1
            )
        }
        let snapshot = try AgentLocalInsightBuilder.build(
            current: rows,
            previous: rows,
            periodStart: start,
            periodEnd: start.addingTimeInterval(604_800)
        )

        XCTAssertLessThanOrEqual(
            snapshot.context.topApplications.count,
            AgentLocalInsightBuilder.itemLimit
        )
        XCTAssertLessThanOrEqual(
            snapshot.context.topApplications[0].name.count,
            AgentLocalInsightBuilder.nameCharacterLimit
        )
        XCTAssertLessThan(snapshot.previewSizeBytes, 25_000)
    }

    private func row(
        app: String,
        destination: String,
        sessions: Int,
        bytes: UInt64,
        unknown: Int = 0
    ) -> AppDestinationTotal {
        AppDestinationTotal(
            processName: app,
            destination: destination,
            sessionCount: sessions,
            bytes: bytes,
            observationsWithoutBytes: unknown
        )
    }
}
