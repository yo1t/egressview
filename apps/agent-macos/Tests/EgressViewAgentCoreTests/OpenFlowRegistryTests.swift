import Foundation
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewNetworkExtension

private func metadata(remotePort: UInt16 = 443, processID: Int32 = 501) -> SocketFlowMetadata {
    SocketFlowMetadata(
        networkProtocol: .tcp,
        localAddress: "192.0.2.10",
        localPort: 49_152,
        remoteAddress: "203.0.113.5",
        remotePort: remotePort,
        processID: processID,
        processName: "Safari",
        bundleID: "com.apple.Safari"
    )
}

final class OpenFlowRegistryTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testClosedFlowCarriesTheByteCountsAndTheOriginalStartTime() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)

        let observation = try XCTUnwrap(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 1_200, bytesOut: 340,
            metadata: nil, reportedAt: start.addingTimeInterval(90)
        ))

        XCTAssertEqual(observation.bytesIn, 1_200)
        XCTAssertEqual(observation.bytesOut, 340)
        // The close report must not become the flow's start time.
        XCTAssertEqual(observation.firstObservedAt, start)
        XCTAssertEqual(observation.lastObservedAt, start.addingTimeInterval(90))
        XCTAssertEqual(observation.collector, .networkExtension)
    }

    func testStatisticsReportsProduceNothing() {
        // A running total for a still-open flow. Whether the counter is
        // cumulative or per-interval has not been measured, and an unverified
        // number is worse than none.
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)

        XCTAssertNil(registry.complete(
            flowID: id, kind: .statistics, bytesIn: 999, bytesOut: 999,
            metadata: nil, reportedAt: start.addingTimeInterval(5)
        ))
        // The flow stays open, so its close report can still be matched.
        XCTAssertEqual(registry.count, 1)
        XCTAssertNotNil(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 10, bytesOut: 20,
            metadata: nil, reportedAt: start.addingTimeInterval(6)
        ))
    }

    func testOtherReportKindsProduceNothing() {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)
        XCTAssertNil(registry.complete(
            flowID: id, kind: .other, bytesIn: 1, bytesOut: 1,
            metadata: nil, reportedAt: start
        ))
    }

    func testClosingReleasesTheEntry() {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)
        _ = registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 1, bytesOut: 1,
            metadata: nil, reportedAt: start
        )
        XCTAssertEqual(registry.count, 0, "an open-flow entry must not outlive its flow")
    }

    func testAnUnknownFlowStillReportsItsBytesUsingTheReportMetadata() throws {
        // Flows opened before monitoring started, or whose entry was evicted,
        // must not lose their byte counts as well as their start time.
        var registry = OpenFlowRegistry()
        let observation = try XCTUnwrap(registry.complete(
            flowID: UUID(), kind: .flowClosed, bytesIn: 7, bytesOut: 8,
            metadata: metadata(), reportedAt: start
        ))
        XCTAssertEqual(observation.bytesIn, 7)
        XCTAssertEqual(observation.firstObservedAt, start, "no start time is known, so the report time is used")
    }

    func testAReportWithNoMetadataAtAllIsDropped() {
        var registry = OpenFlowRegistry()
        XCTAssertNil(registry.complete(
            flowID: UUID(), kind: .flowClosed, bytesIn: 1, bytesOut: 1,
            metadata: nil, reportedAt: start
        ))
    }

    func testOpenFlowsAreBoundedSoLongLivedMonitoringCannotGrowWithoutLimit() {
        var registry = OpenFlowRegistry(capacity: 3)
        var ids: [UUID] = []
        for index in 0..<5 {
            let id = UUID()
            ids.append(id)
            registry.register(
                flowID: id, metadata: metadata(remotePort: UInt16(1_000 + index)),
                startedAt: start.addingTimeInterval(Double(index))
            )
        }
        XCTAssertEqual(registry.count, 3)

        // The oldest were dropped: their bytes still arrive, only the start
        // time is lost.
        let evicted = registry.complete(
            flowID: ids[0], kind: .flowClosed, bytesIn: 5, bytesOut: 5,
            metadata: metadata(), reportedAt: start.addingTimeInterval(100)
        )
        XCTAssertEqual(evicted?.bytesIn, 5)
        XCTAssertEqual(evicted?.firstObservedAt, start.addingTimeInterval(100))

        // The newest kept its real start time.
        let kept = registry.complete(
            flowID: ids[4], kind: .flowClosed, bytesIn: 6, bytesOut: 6,
            metadata: nil, reportedAt: start.addingTimeInterval(100)
        )
        XCTAssertEqual(kept?.firstObservedAt, start.addingTimeInterval(4))
    }

    func testStaleOpenFlowsCanBeEvictedByAge() {
        var registry = OpenFlowRegistry()
        let old = UUID()
        let recent = UUID()
        registry.register(flowID: old, metadata: metadata(), startedAt: start)
        registry.register(
            flowID: recent, metadata: metadata(), startedAt: start.addingTimeInterval(3_600)
        )

        registry.evictEntries(startedBefore: start.addingTimeInterval(1_800))
        XCTAssertEqual(registry.count, 1)
        XCTAssertNotNil(registry.complete(
            flowID: recent, kind: .flowClosed, bytesIn: 1, bytesOut: 1,
            metadata: nil, reportedAt: start.addingTimeInterval(7_200)
        ))
    }

    func testRegisteringTheSameFlowTwiceDoesNotDuplicateIt() {
        var registry = OpenFlowRegistry(capacity: 2)
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)
        registry.register(flowID: id, metadata: metadata(), startedAt: start.addingTimeInterval(1))
        XCTAssertEqual(registry.count, 1)
    }

    func testTheFlowStillReportsNoBytesUntilItCloses() {
        // What `handleNewFlow` records: metadata now, byte counts unknown.
        // Zero would read as "sent nothing".
        let observation = NetworkFlowObservationMapper().map(metadata(), observedAt: start)
        XCTAssertNil(observation.bytesIn)
        XCTAssertNil(observation.bytesOut)
    }
}
