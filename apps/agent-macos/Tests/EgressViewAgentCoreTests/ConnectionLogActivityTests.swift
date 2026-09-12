import XCTest
@testable import EgressViewAgentCore

/// Which rows in the connection log have not ended.
///
/// The first version of this asked whether the last-observed time was recent.
/// On the shipping path that is the opposite of the truth twice over, because
/// a flow is reported exactly twice -- at open and at close -- and nothing
/// moves its last-observed time in between (P3-107).
final class ConnectionLogActivityTests: XCTestCase {
    private func observation(
        bytesIn: UInt64?, bytesOut: UInt64?,
        collector: CollectorKind = .networkExtension,
        firstObservedAt: Date = Date(timeIntervalSince1970: 1_000),
        lastObservedAt: Date = Date(timeIntervalSince1970: 1_000)
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10", localPort: 51_000,
            remoteAddress: "192.0.2.20", remotePort: 443,
            processID: 501, processName: "curl", bundleID: nil,
            firstObservedAt: firstObservedAt, lastObservedAt: lastObservedAt,
            bytesIn: bytesIn, bytesOut: bytesOut,
            collector: collector, confidence: .exact
        )
    }

    func test通信量が無い行はまだ終わっていない() {
        // Byte counts arrive with the close report and only then.
        XCTAssertTrue(ConnectionLogActivity.isOpen(observation(bytesIn: nil, bytesOut: nil)))
    }

    func test通信量がある行は終わっている() {
        XCTAssertFalse(ConnectionLogActivity.isOpen(observation(bytesIn: 1_024, bytesOut: 2_048)))
        XCTAssertFalse(ConnectionLogActivity.isOpen(observation(bytesIn: 0, bytesOut: 0)))
        XCTAssertFalse(ConnectionLogActivity.isOpen(observation(bytesIn: 1_024, bytesOut: nil)))
    }

    func test長く開いている通信も終わっていないと言える() {
        // The defect, stated as a test. Judged by recency, a flow open for an
        // hour would be called finished because nothing has moved its
        // last-observed time since it opened.
        let anHourAgo = Date(timeIntervalSince1970: 1_000)
        let open = observation(
            bytesIn: nil, bytesOut: nil,
            firstObservedAt: anHourAgo, lastObservedAt: anHourAgo
        )
        XCTAssertTrue(ConnectionLogActivity.isOpen(open), "1時間開いている通信を終了扱いにした")
    }

    func test直前に終わった通信を継続中と言わない() {
        // The other half of the same defect: judged by recency, a flow that
        // closed a second ago is the most recent thing on screen.
        let justNow = Date()
        let closed = observation(
            bytesIn: 4_096, bytesOut: 512,
            firstObservedAt: justNow.addingTimeInterval(-30), lastObservedAt: justNow
        )
        XCTAssertFalse(ConnectionLogActivity.isOpen(closed), "終わった通信を継続中と言った")
    }

    func test終了を報告しない収集器には何も言わない() {
        // Only the Network Extension reports closes. Anything else gets no
        // claim rather than one that cannot be supported.
        XCTAssertFalse(ConnectionLogActivity.isOpen(
            observation(bytesIn: nil, bytesOut: nil, collector: .libproc)
        ))
    }
}
