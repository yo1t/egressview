import EgressViewAgentCore
import XCTest

final class LightweightCollectorTests: XCTestCase {
    func testPollEmitsSampledObservation() throws {
        let date = Date(timeIntervalSince1970: 100)
        let provider = StubProvider(observations: [sample(date: date)])
        var emitted: [[ConnectionObservation]] = []
        let collector = LightweightCollector(provider: provider, handler: { emitted.append($0) })

        let observations = try collector.pollOnce(at: date)

        XCTAssertEqual(observations.count, 1)
        XCTAssertEqual(emitted, [observations])
        XCTAssertEqual(observations[0].confidence, .sampled)
    }

    func testLiveLibProcSnapshotCompletesWithoutElevatedPrivileges() throws {
        let observations = try LibProcSocketSnapshotProvider(capacity: 128).snapshot()
        XCTAssertLessThanOrEqual(observations.count, 128)
        XCTAssertTrue(observations.allSatisfy { $0.collector == .libproc })
    }

    private func sample(date: Date) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: .tcp,
            localAddress: "127.0.0.1",
            localPort: 50_000,
            remoteAddress: "127.0.0.1",
            remotePort: 443,
            processID: 1,
            processName: "sample",
            firstObservedAt: date,
            lastObservedAt: date,
            collector: .libproc,
            confidence: .sampled
        )
    }
}

private struct StubProvider: SocketSnapshotProviding {
    let observations: [ConnectionObservation]

    func snapshot(at date: Date) throws -> [ConnectionObservation] {
        observations
    }
}
