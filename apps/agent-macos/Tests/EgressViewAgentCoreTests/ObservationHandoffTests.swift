import Foundation
import XCTest
@testable import EgressViewAgentCore

/// The Extension emptied its queue as it replied, so a reply that never
/// reached the app lost every observation in it (P3-181). A batch now stays
/// until the app says it has stored it.
final class ObservationHandoffTests: XCTestCase {
    private func observation(_ port: UInt16) -> ConnectionObservation {
        let at = Date(timeIntervalSince1970: 1_800_000_000)
        return ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.10", localPort: port,
            remoteAddress: "203.0.113.5", remotePort: 443, processID: 501, processName: "curl",
            bundleID: nil, firstObservedAt: at, lastObservedAt: at,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension, confidence: .exact
        )
    }

    func test届いたと言われるまで同じ番号で渡し直す() {
        var handoff = ObservationHandoff(firstID: 100)
        handoff.enqueue(observation(1))
        let first = handoff.take(acknowledging: 0)
        XCTAssertEqual(first.batch?.id, 100)
        XCTAssertFalse(first.isResend)

        // The reply was lost: the app still acknowledges nothing new.
        handoff.enqueue(observation(2))
        let again = handoff.take(acknowledging: 0)
        XCTAssertEqual(again.batch?.id, 100, "同じ番号で")
        XCTAssertTrue(again.isResend)
        XCTAssertEqual(again.batch?.observations.map(\.localPort), [1], "同じ中身で。後から来た分は混ぜない")

        let next = handoff.take(acknowledging: 100)
        XCTAssertEqual(next.batch?.id, 101)
        XCTAssertEqual(next.batch?.observations.map(\.localPort), [2], "届いた分を手放してから次へ")
        XCTAssertFalse(next.isResend)
    }

    func test何も無ければ何も渡さず確認済みの分は手放す() {
        var handoff = ObservationHandoff(firstID: 7)
        XCTAssertNil(handoff.take(acknowledging: 0).batch)
        handoff.enqueue(observation(1))
        _ = handoff.take(acknowledging: 0)
        XCTAssertNil(handoff.take(acknowledging: 7).batch)
        XCTAssertNil(handoff.inFlight)
    }

    func test上限を超えたら待っている中の最も古いものを捨てる() {
        var handoff = ObservationHandoff(capacity: 2, firstID: 1)
        XCTAssertFalse(handoff.enqueue(observation(1)))
        XCTAssertFalse(handoff.enqueue(observation(2)))
        XCTAssertTrue(handoff.enqueue(observation(3)))
        XCTAssertEqual(handoff.pending.map(\.localPort), [2, 3])
    }

    func test受け取り側は保存済みの番号を二重に保存しない() {
        var receiver = ObservationHandoffReceiver()
        XCTAssertEqual(receiver.acknowledgement, 0)
        XCTAssertEqual(receiver.decide(100), .store)
        receiver.stored(100)
        XCTAssertEqual(receiver.acknowledgement, 100)
        XCTAssertEqual(receiver.decide(100), .alreadyStored)
        XCTAssertEqual(receiver.decide(101), .store)
    }

    func test保存に失敗し続ける番号は決まった回数であきらめる() {
        var receiver = ObservationHandoffReceiver(maximumAttempts: 3)
        receiver.stored(9)
        XCTAssertFalse(receiver.failed(10))
        XCTAssertFalse(receiver.failed(10))
        XCTAssertEqual(receiver.acknowledgement, 9, "まだ確認しない。拡張機能は渡し直す")
        XCTAssertTrue(receiver.failed(10))
        XCTAssertEqual(receiver.acknowledgement, 10, "3回目で確認し、後ろを詰まらせない")
    }

    func test別の番号の失敗は数え直す() {
        var receiver = ObservationHandoffReceiver(maximumAttempts: 2)
        XCTAssertFalse(receiver.failed(10))
        XCTAssertFalse(receiver.failed(11))
        XCTAssertTrue(receiver.failed(11))
    }

    func test拡張機能と本体を通して返事が失われても記録は失われない() {
        var handoff = ObservationHandoff(firstID: 500)
        var receiver = ObservationHandoffReceiver()
        var stored: [UInt16] = []
        for port in 1...3 { handoff.enqueue(observation(UInt16(port))) }

        // First request: the reply is lost on the way.
        _ = handoff.take(acknowledging: receiver.acknowledgement)
        handoff.enqueue(observation(4))

        // Second request: the same batch arrives and is stored.
        for _ in 0..<3 {
            let (batch, _) = handoff.take(acknowledging: receiver.acknowledgement)
            guard let batch else { break }
            if receiver.decide(batch.id) == .store {
                stored += batch.observations.map(\.localPort)
                receiver.stored(batch.id)
            }
        }
        XCTAssertEqual(stored, [1, 2, 3, 4])
        XCTAssertNil(handoff.take(acknowledging: receiver.acknowledgement).batch)
    }
}
