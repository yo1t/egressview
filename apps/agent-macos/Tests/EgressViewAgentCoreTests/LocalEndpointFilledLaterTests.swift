import Foundation
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewNetworkExtension

// A flow is first seen before the system has chosen its local address and
// port. They must be taken from a later reading, or the Hub cannot match the
// flow to the router's record of it.

private func metadata(localAddress: String, localPort: UInt16) -> SocketFlowMetadata {
    SocketFlowMetadata(
        networkProtocol: .tcp,
        localAddress: localAddress,
        localPort: localPort,
        remoteAddress: "203.0.113.5",
        remotePort: 443,
        processID: 501,
        processName: "Safari",
        bundleID: "com.apple.Safari"
    )
}

private func observation(
    localAddress: String, localPort: UInt16, at: Date, flowID: UUID,
    bytesIn: UInt64? = nil, bytesOut: UInt64? = nil
) -> ConnectionObservation {
    ConnectionObservation(
        networkProtocol: .tcp,
        localAddress: localAddress,
        localPort: localPort,
        remoteAddress: "203.0.113.5",
        remotePort: 443,
        processID: 501,
        processName: "Safari",
        bundleID: "com.apple.Safari",
        firstObservedAt: at,
        lastObservedAt: at,
        bytesIn: bytesIn,
        bytesOut: bytesOut,
        collector: .networkExtension,
        confidence: .exact,
        flowID: flowID
    )
}

final class LocalEndpointMetadataTests: XCTestCase {
    func testUnboundReadingsHaveNoLocalEndpoint() {
        XCTAssertFalse(metadata(localAddress: "0.0.0.0", localPort: 0).hasLocalEndpoint)
        XCTAssertFalse(metadata(localAddress: "::", localPort: 0).hasLocalEndpoint)
        XCTAssertFalse(metadata(localAddress: "", localPort: 0).hasLocalEndpoint)
        XCTAssertFalse(metadata(localAddress: "192.0.2.10", localPort: 0).hasLocalEndpoint)
        XCTAssertFalse(metadata(localAddress: "0.0.0.0", localPort: 49_152).hasLocalEndpoint)
        XCTAssertTrue(metadata(localAddress: "192.0.2.10", localPort: 49_152).hasLocalEndpoint)
        XCTAssertTrue(metadata(localAddress: "2001:db8::10", localPort: 49_152).hasLocalEndpoint)
    }
}

final class LocalEndpointRegistryTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testTheOpeningObservationUsesTheEndpointKnownAtTheFirstBytes() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(localAddress: "0.0.0.0", localPort: 0), startedAt: start)
        registry.noteLocalEndpoint(flowID: id, from: metadata(localAddress: "192.0.2.10", localPort: 49_152))
        let opening = try XCTUnwrap(registry.openingObservation(flowID: id, observedAt: start.addingTimeInterval(1)))
        XCTAssertEqual(opening.localAddress, "192.0.2.10")
        XCTAssertEqual(opening.localPort, 49_152)
    }

    func testAKnownEndpointIsNeverReplaced() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(localAddress: "192.0.2.10", localPort: 49_152), startedAt: start)
        registry.noteLocalEndpoint(flowID: id, from: metadata(localAddress: "192.0.2.99", localPort: 50_000))
        let opening = try XCTUnwrap(registry.openingObservation(flowID: id, observedAt: start))
        XCTAssertEqual(opening.localAddress, "192.0.2.10")
        XCTAssertEqual(opening.localPort, 49_152)
    }

    func testAnUnboundReadingChangesNothing() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(localAddress: "0.0.0.0", localPort: 0), startedAt: start)
        registry.noteLocalEndpoint(flowID: id, from: metadata(localAddress: "0.0.0.0", localPort: 0))
        let opening = try XCTUnwrap(registry.openingObservation(flowID: id, observedAt: start))
        XCTAssertEqual(opening.localPort, 0)
    }

    func testTheClosingReportFillsAnEndpointTheFlowBeganWithout() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(localAddress: "0.0.0.0", localPort: 0), startedAt: start)
        let closed = try XCTUnwrap(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 10, bytesOut: 20,
            metadata: metadata(localAddress: "192.0.2.10", localPort: 49_152),
            reportedAt: start.addingTimeInterval(5)
        ))
        XCTAssertEqual(closed.localAddress, "192.0.2.10")
        XCTAssertEqual(closed.localPort, 49_152)
        XCTAssertEqual(closed.firstObservedAt, start, "the start time still comes from the registry")
    }

    func testTheClosingReportDoesNotReplaceAKnownEndpoint() throws {
        var registry = OpenFlowRegistry()
        let id = UUID()
        registry.register(flowID: id, metadata: metadata(localAddress: "192.0.2.10", localPort: 49_152), startedAt: start)
        let closed = try XCTUnwrap(registry.complete(
            flowID: id, kind: .flowClosed, bytesIn: 10, bytesOut: 20,
            metadata: metadata(localAddress: "192.0.2.99", localPort: 50_000),
            reportedAt: start
        ))
        XCTAssertEqual(closed.localPort, 49_152)
    }
}

final class LocalEndpointMergeTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testAQueuedOpeningTakesTheEndpointFromTheClosingReport() {
        let id = UUID()
        let opening = observation(localAddress: "0.0.0.0", localPort: 0, at: start, flowID: id)
        let closing = observation(localAddress: "192.0.2.10", localPort: 49_152, at: start.addingTimeInterval(5), flowID: id, bytesIn: 1, bytesOut: 2)
        let merged = opening.merging(closing)
        XCTAssertEqual(merged.localAddress, "192.0.2.10")
        XCTAssertEqual(merged.localPort, 49_152)
    }

    func testAKnownEndpointSurvivesAMergeWithAnUnboundOne() {
        let id = UUID()
        let known = observation(localAddress: "192.0.2.10", localPort: 49_152, at: start, flowID: id)
        let unbound = observation(localAddress: "0.0.0.0", localPort: 0, at: start.addingTimeInterval(5), flowID: id)
        XCTAssertEqual(known.merging(unbound).localPort, 49_152)
        XCTAssertEqual(known.merging(unbound).localAddress, "192.0.2.10")
    }
}

final class LocalEndpointStoreTests: XCTestCase {
    private var directory: URL!
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-endpoint-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testTheStoredRowTakesTheEndpointFromALaterReport() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let id = UUID()
        try store.append([observation(localAddress: "0.0.0.0", localPort: 0, at: start, flowID: id)])
        try store.append([observation(
            localAddress: "192.0.2.10", localPort: 49_152, at: start.addingTimeInterval(5),
            flowID: id, bytesIn: 1, bytesOut: 2
        )])
        XCTAssertEqual(try store.statistics().rawCount, 1)
        let row = try XCTUnwrap(try store.observations().first)
        XCTAssertEqual(row.localAddress, "192.0.2.10")
        XCTAssertEqual(row.localPort, 49_152)
    }

    func testTheStoredRowKeepsAKnownEndpoint() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let id = UUID()
        try store.append([observation(localAddress: "192.0.2.10", localPort: 49_152, at: start, flowID: id)])
        try store.append([observation(
            localAddress: "0.0.0.0", localPort: 0, at: start.addingTimeInterval(5),
            flowID: id, bytesIn: 1, bytesOut: 2
        )])
        let row = try XCTUnwrap(try store.observations().first)
        XCTAssertEqual(row.localAddress, "192.0.2.10")
        XCTAssertEqual(row.localPort, 49_152)
    }
}
