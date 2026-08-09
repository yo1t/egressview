import EgressViewAgentCore
import XCTest

final class ConnectionObservationTests: XCTestCase {
    func testStableKeySeparatesProcessesForTheSameFlow() {
        let date = Date(timeIntervalSince1970: 100)
        let first = observation(processID: 10, date: date)
        let second = observation(processID: 11, date: date)

        XCTAssertNotEqual(first.stableKey, second.stableKey)
        XCTAssertNil(first.bytesIn)
        XCTAssertNil(first.bytesOut)
        XCTAssertEqual(first.collector, .libproc)
        XCTAssertEqual(first.confidence, .sampled)
    }

    func testDeduplicatorPreservesFirstSeenAndAdvancesLastSeen() {
        let firstDate = Date(timeIntervalSince1970: 100)
        let secondDate = Date(timeIntervalSince1970: 102)
        var deduplicator = ObservationDeduplicator()

        _ = deduplicator.merge([observation(processID: 10, date: firstDate)], observedAt: firstDate)
        let result = deduplicator.merge(
            [observation(processID: 10, date: secondDate)],
            observedAt: secondDate
        )

        XCTAssertEqual(result.count, 1)
        XCTAssertEqual(result[0].firstObservedAt, firstDate)
        XCTAssertEqual(result[0].lastObservedAt, secondDate)
    }

    func testIPv6AddressIsPartOfStableKeyWithoutNormalizationLoss() {
        let date = Date(timeIntervalSince1970: 100)
        let item = ConnectionObservation(
            networkProtocol: .udp,
            localAddress: "2001:db8::1",
            localPort: 53_000,
            remoteAddress: "2606:4700:4700::1111",
            remotePort: 443,
            processID: 42,
            processName: "resolver",
            firstObservedAt: date,
            lastObservedAt: date,
            collector: .networkExtension,
            confidence: .exact
        )

        XCTAssertTrue(item.stableKey.contains("2606:4700:4700::1111"))
        XCTAssertEqual(item.networkProtocol, .udp)
    }

    private func observation(processID: Int32, date: Date) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "192.0.2.10",
            localPort: 50_000,
            remoteAddress: "198.51.100.20",
            remotePort: 443,
            processID: processID,
            processName: "sample",
            firstObservedAt: date,
            lastObservedAt: date,
            collector: .libproc,
            confidence: .sampled
        )
    }
}
