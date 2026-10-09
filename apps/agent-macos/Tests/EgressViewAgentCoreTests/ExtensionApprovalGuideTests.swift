import Foundation
import XCTest
@testable import EgressViewAgentCore

final class ExtensionApprovalGuideTests: XCTestCase {
    private func version(_ major: Int) -> OperatingSystemVersion {
        OperatingSystemVersion(majorVersion: major, minorVersion: 0, patchVersion: 0)
    }

    func test_macOS15以降はログイン項目と機能拡張のカテゴリ別へ案内する() {
        for major in [15, 26, 27] {
            let steps = ExtensionApprovalGuide.steps(for: version(major))
            XCTAssertTrue(steps.contains { $0.contains("Login Items & Extensions") }, "\(major)")
            XCTAssertTrue(steps.contains { $0.contains("By Category") }, "\(major)")
            XCTAssertTrue(steps.contains { $0.contains("Network Extensions") }, "\(major)")
            XCTAssertEqual(
                ExtensionApprovalGuide.settingsURL(for: version(major)).absoluteString,
                "x-apple.systempreferences:com.apple.LoginItems-Settings.extension"
            )
        }
    }

    func test_macOS13と14はプライバシーとセキュリティの許可へ案内する() {
        for major in [13, 14] {
            let steps = ExtensionApprovalGuide.steps(for: version(major))
            XCTAssertTrue(steps.contains { $0.contains("Privacy & Security") }, "\(major)")
            XCTAssertFalse(steps.contains { $0.contains("By Category") }, "\(major)")
            XCTAssertTrue(ExtensionApprovalGuide.settingsURL(for: version(major)).absoluteString
                .hasPrefix("x-apple.systempreferences:com.apple.preference.security"))
        }
    }

    func test_どの版でもコンテンツフィルタの許可まで案内する() {
        for major in [13, 14, 15, 27] {
            XCTAssertTrue(ExtensionApprovalGuide.steps(for: version(major)).last?.contains("filtering network content") == true)
        }
    }
}
