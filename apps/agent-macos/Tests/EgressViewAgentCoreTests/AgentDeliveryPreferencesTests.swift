import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentDeliveryPreferencesTests: XCTestCase {
    func testDeliveryIsOffByDefaultAndRequiresExplicitEnable() throws {
        let suite = "com.egressview.agent.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = AgentDeliveryPreferences(defaults: defaults)

        XCTAssertFalse(preferences.isEnabled)
        preferences.isEnabled = true
        XCTAssertTrue(AgentDeliveryPreferences(defaults: defaults).isEnabled)
    }
}
