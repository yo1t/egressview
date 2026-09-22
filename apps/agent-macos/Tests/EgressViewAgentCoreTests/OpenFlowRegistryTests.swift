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

    func test時計が巻き戻っても終わりが始まりより前にならない() throws {
        // Measured on a Mac on 2026-09-12: three flows registered at 00:32:14
        // reported their close at 00:32:12 and 00:32:13. The Hub refuses a
        // batch carrying such a row -- a flow cannot end before it began --
        // and on Windows one such row stopped delivery for three hours and
        // cost 42,545 observations (P3-148).
        var registry = OpenFlowRegistry()
        let id = UUID()
        let uptime = ContinuousClock.now
        registry.register(flowID: id, metadata: metadata(), startedAt: start, uptime: uptime)

        // Two seconds of real time pass, and the wall clock is set back three.
        let observation = try XCTUnwrap(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 10, bytesOut: 20,
            metadata: nil,
            reportedAt: start.addingTimeInterval(-3),
            uptime: uptime.advanced(by: .seconds(2))
        ))

        XCTAssertEqual(observation.firstObservedAt, start)
        XCTAssertGreaterThanOrEqual(
            observation.lastObservedAt, observation.firstObservedAt,
            "終わりが始まりより前になっている"
        )
        // The duration that was actually measured, not a flow clamped to zero:
        // clamping would lose the fact that it lasted at all.
        XCTAssertEqual(
            observation.lastObservedAt.timeIntervalSince(start), 2, accuracy: 0.05,
            "実際に経過した2秒が残らなければならない"
        )
    }

    func test時計が正しいときは報告された時刻をそのまま使う() throws {
        // The repair must not touch the ordinary case: the system's own close
        // time is the honest answer whenever it is not impossible.
        var registry = OpenFlowRegistry()
        let id = UUID()
        let uptime = ContinuousClock.now
        registry.register(flowID: id, metadata: metadata(), startedAt: start, uptime: uptime)

        let observation = try XCTUnwrap(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 1, bytesOut: 2,
            metadata: nil,
            reportedAt: start.addingTimeInterval(90),
            // Deliberately disagrees with the wall clock: the wall clock wins
            // while it is still possible.
            uptime: uptime.advanced(by: .seconds(5))
        ))

        XCTAssertEqual(observation.lastObservedAt, start.addingTimeInterval(90))
    }

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
        XCTAssertEqual(observation.flowID, id)
    }

    func testOpeningObservationCarriesSNIAndIsEmittedOnlyOnce() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(), startedAt: start)
        registry.noteServerName("api.example.com", flowID: id)

        let opening = try XCTUnwrap(registry.openingObservation(
            flowID: id, observedAt: start.addingTimeInterval(0.1)
        ))
        XCTAssertEqual(opening.flowID, id)
        XCTAssertEqual(opening.remoteHostname, "api.example.com")
        XCTAssertNil(opening.bytesIn)
        XCTAssertNil(registry.openingObservation(
            flowID: id, observedAt: start.addingTimeInterval(0.2)
        ))
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

/// The name a QUIC client asked for, and when it reaches the store (P3-114).
///
/// Measured on one Mac 2026-09-13: the Extension read a name for 4,568 of
/// 4,579 QUIC flows, and the store held one for 72.8% of them. The gap was
/// entirely flows whose ClientHello spanned two datagrams -- the opening
/// observation had already gone without a name, and nothing carried it until
/// the flow closed. About one flow in ten never closes, so those names were
/// lost for good.
final class OpenFlowServerNameTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private let flowID = UUID()

    private func registered() -> OpenFlowRegistry {
        var registry = OpenFlowRegistry()
        registry.register(flowID: flowID, metadata: metadata(), startedAt: start)
        return registry
    }

    func test一発で読めた名前は開始の観測に乗る() {
        var registry = registered()
        let extra = registry.noteServerName("example.test", flowID: flowID, observedAt: start)
        XCTAssertNil(extra, "開始前に読めているのに、余分な観測を出した")
        let opening = registry.openingObservation(flowID: flowID, observedAt: start)
        XCTAssertEqual(opening?.remoteHostname, "example.test")
    }

    func test遅れて読めた名前はその場で観測として出る() {
        // The defect, stated as a test. Without this the name waits for the
        // flow to close, and a flow that never closes never carries it.
        var registry = registered()
        let opening = registry.openingObservation(flowID: flowID, observedAt: start)
        XCTAssertNil(opening?.remoteHostname, "前提が崩れている: 開始時点で名前があった")

        let late = registry.noteServerName(
            "example.test", flowID: flowID, observedAt: start.addingTimeInterval(0.2)
        )
        let observation = try? XCTUnwrap(late)
        XCTAssertEqual(observation?.remoteHostname, "example.test", "遅れた名前が出ていない")
        XCTAssertEqual(observation?.flowID, flowID)
    }

    func test遅れて出す観測は終了とは読めない形にする() {
        // Byte counts arrive with the close report and only then, and the
        // screen decides "not ended" from their absence (P3-108). A late name
        // carrying zeros would report an ending that did not happen.
        var registry = registered()
        _ = registry.openingObservation(flowID: flowID, observedAt: start)
        let late = registry.noteServerName("example.test", flowID: flowID, observedAt: start)
        XCTAssertNil(late?.bytesIn)
        XCTAssertNil(late?.bytesOut)
        XCTAssertEqual(late?.firstObservedAt, start, "開始時刻が書き換わった")
    }

    func test同じ名前を二度書かない() {
        var registry = registered()
        _ = registry.openingObservation(flowID: flowID, observedAt: start)
        XCTAssertNotNil(registry.noteServerName("example.test", flowID: flowID))
        XCTAssertNil(
            registry.noteServerName("other.test", flowID: flowID),
            "一度付いた名前を上書きして、二度目も出した"
        )
    }

    func test知らないflowには何もしない() {
        var registry = registered()
        XCTAssertNil(registry.noteServerName("example.test", flowID: UUID()))
    }

    func test閉じたときにも名前は残る() {
        var registry = registered()
        _ = registry.openingObservation(flowID: flowID, observedAt: start)
        _ = registry.noteServerName("example.test", flowID: flowID)
        let closed = registry.complete(
            flowID: flowID, kind: .flowClosed, bytesIn: 10, bytesOut: 20,
            metadata: nil, reportedAt: start.addingTimeInterval(5)
        )
        XCTAssertEqual(closed?.remoteHostname, "example.test")
    }
}
