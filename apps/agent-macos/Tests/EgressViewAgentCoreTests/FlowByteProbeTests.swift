import XCTest
@testable import EgressViewNetworkExtension

final class FlowByteProbeTests: XCTestCase {
    func testSequentialChunksAdvanceWithoutReadingContent() {
        var probe = FlowByteProbe()
        probe.observe(offset: 0, length: 512)
        probe.observe(offset: 512, length: 1_024)
        XCTAssertEqual(probe.furthestObservedEnd, 1_536)
        XCTAssertFalse(probe.hasGap)
    }

    func testOverlappingCallbacksDoNotDoubleCount() {
        var probe = FlowByteProbe()
        probe.observe(offset: 0, length: 512)
        probe.observe(offset: 256, length: 512)
        XCTAssertEqual(probe.furthestObservedEnd, 768)
        XCTAssertEqual(probe.presentedBytes, 1_024)
        XCTAssertEqual(probe.callbackCount, 2)
        XCTAssertEqual(probe.zeroOffsetCallbacks, 1)
        XCTAssertFalse(probe.hasGap)
    }

    func testRepeatedZeroOffsetsAreObservableButNotSummedAsFlowBytes() {
        var probe = FlowByteProbe()
        probe.observe(offset: 0, length: 1_200)
        probe.observe(offset: 0, length: 800)
        XCTAssertEqual(probe.callbackCount, 2)
        XCTAssertEqual(probe.zeroOffsetCallbacks, 2)
        XCTAssertEqual(probe.presentedBytes, 2_000)
        XCTAssertEqual(probe.furthestObservedEnd, 1_200)
    }

    func testMissingCallbackIsNotPresentedAsCompleteMeasurement() {
        var probe = FlowByteProbe()
        probe.observe(offset: 0, length: 512)
        probe.observe(offset: 1_024, length: 256)
        XCTAssertEqual(probe.furthestObservedEnd, 1_280)
        XCTAssertTrue(probe.hasGap)
    }

    func testInvalidOffsetsDoNotAdvance() {
        var probe = FlowByteProbe()
        probe.observe(offset: -1, length: 10)
        probe.observe(offset: 0, length: 0)
        XCTAssertEqual(probe.furthestObservedEnd, 0)
        XCTAssertTrue(probe.hasGap)
    }

    func testCompleteCountsRequireBothDirections() {
        var inbound = FlowByteProbe()
        var outbound = FlowByteProbe()
        inbound.observe(offset: 0, length: 500_000)
        XCTAssertNil(FlowByteProbe.completeCounts(inbound: inbound, outbound: outbound, truncated: false))
        outbound.observe(offset: 0, length: 1_800)
        let counts = FlowByteProbe.completeCounts(inbound: inbound, outbound: outbound, truncated: false)
        XCTAssertEqual(counts?.inbound, 500_000)
        XCTAssertEqual(counts?.outbound, 1_800)
    }

    func testIncompleteCountsRemainUnmeasured() {
        var inbound = FlowByteProbe()
        var outbound = FlowByteProbe()
        inbound.observe(offset: 0, length: 100)
        outbound.observe(offset: 0, length: 50)
        XCTAssertNil(FlowByteProbe.completeCounts(inbound: inbound, outbound: outbound, truncated: true))
        inbound.observe(offset: 200, length: 100)
        XCTAssertNil(FlowByteProbe.completeCounts(inbound: inbound, outbound: outbound, truncated: false))
    }
}
