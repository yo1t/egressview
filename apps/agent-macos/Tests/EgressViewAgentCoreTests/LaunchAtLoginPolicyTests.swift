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

    func testActiveMonitoringRegistersUnlessTheUserOptedOut() {
        XCTAssertEqual(
            LaunchAtLoginPolicy.automaticAction(
                for: .disabled,
                monitoringActive: true,
                userOptedOut: false
            ),
            .register
        )
        XCTAssertEqual(
            LaunchAtLoginPolicy.automaticAction(
                for: .disabled,
                monitoringActive: true,
                userOptedOut: true
            ),
            .none
        )
    }

    func testPausedOrAlreadyRegisteredMonitoringDoesNothingAutomatically() {
        XCTAssertEqual(
            LaunchAtLoginPolicy.automaticAction(
                for: .disabled,
                monitoringActive: false,
                userOptedOut: false
            ),
            .none
        )
        XCTAssertEqual(
            LaunchAtLoginPolicy.automaticAction(
                for: .enabled,
                monitoringActive: true,
                userOptedOut: false
            ),
            .none
        )
        XCTAssertEqual(
            LaunchAtLoginPolicy.automaticAction(
                for: .requiresApproval,
                monitoringActive: true,
                userOptedOut: false
            ),
            .none
        )
    }
}
