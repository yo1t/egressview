import EgressViewNetworkExtension
import XCTest

final class PassOnlyFlowPolicyTests: XCTestCase {
    func testPolicyNeverReadsPayloadAndAlwaysAllowsFlow() {
        let policy = PassOnlyFlowPolicy()

        XCTAssertFalse(policy.readsPayload)
        XCTAssertEqual(policy.decision, .allowAndReportMetadata)
    }
}
