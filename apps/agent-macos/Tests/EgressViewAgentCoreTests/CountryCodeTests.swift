import XCTest
@testable import EgressViewAgentCore

/// What the screen counts when it says how many countries (P3-109).
final class CountryCodeTests: XCTestCase {
    func test国は国として数える() {
        for code in ["JP", "US", "SG", "HK", "ZA"] {
            XCTAssertTrue(CountryCode.isRegion(code), "\(code)が国として数えられていない")
        }
    }

    func test地域不明は数えない() {
        // The defect, stated as a test: counted, the screen reports a country
        // nobody went to. Measured on one Mac, 38 rows included one ZZ.
        XCTAssertFalse(CountryCode.isRegion("ZZ"))
        XCTAssertFalse(CountryCode.isRegion("zz"))
    }

    func test地域不明を除いて数える() {
        let codes = ["JP", "US", "ZZ", "SG"]
        XCTAssertEqual(CountryCode.countries(codes).sorted(), ["JP", "SG", "US"])
    }

    func test符号として成り立たないものは数えない() {
        for code in ["", "J", "JPN", "12", "日本"] {
            XCTAssertFalse(CountryCode.isRegion(code), "\(code)を国として数えた")
        }
    }

    func test地図に描けるかどうかは数え方に関係しない() {
        // Two destinations on the measured Mac have no outline in the 110m
        // atlas -- one of them carrying 9,835 connections. They are still
        // places the Mac reached, and the count says where traffic went.
        XCTAssertTrue(CountryCode.isRegion("SG"))
        XCTAssertTrue(CountryCode.isRegion("HK"))
    }

    func test大文字小文字を問わない() {
        XCTAssertTrue(CountryCode.isRegion("jp"))
        XCTAssertEqual(CountryCode.countries(["jp"]), ["JP"])
    }
}
