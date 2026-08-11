import XCTest
@testable import EgressViewAgentCore

final class LaunchAtLoginPolicyTests: XCTestCase {
    func testDisabledStateRegistersOnlyAfterUserAction() {
        XCTAssertEqual(LaunchAtLoginPolicy.action(for: .disabled), .register)
    }

    func testEnabledStateUnregisters() {
        XCTAssertEqual(LaunchAtLoginPolicy.action(for: .enabled), .unregister)
    }

    func testApprovalStateOpensSystemSettingsInsteadOfRegisteringAgain() {
        XCTAssertEqual(LaunchAtLoginPolicy.action(for: .requiresApproval), .openSystemSettings)
    }

    func testUnavailableStateLetsServiceManagementValidateRegistration() {
        XCTAssertEqual(LaunchAtLoginPolicy.action(for: .unavailable), .register)
    }
}
