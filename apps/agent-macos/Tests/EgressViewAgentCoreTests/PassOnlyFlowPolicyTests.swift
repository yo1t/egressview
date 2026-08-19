import EgressViewNetworkExtension
import XCTest

final class PassOnlyFlowPolicyTests: XCTestCase {
    func testPolicyNeverReadsApplicationContentAndAlwaysAllowsFlow() {
        let policy = PassOnlyFlowPolicy()

        XCTAssertFalse(policy.readsApplicationContent)
        XCTAssertEqual(policy.decision, .allowAndReportMetadata)
    }
}
