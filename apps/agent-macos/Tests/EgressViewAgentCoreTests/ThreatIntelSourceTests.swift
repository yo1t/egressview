import XCTest
@testable import EgressViewAgentCore

/// The property this file exists for: **a Hub-enrolled agent never contacts a
/// third party for threat data, whatever the Hub is doing.**
///
/// Written after noticing it had been declared the most important thing to
/// protect and then never measured.
final class ThreatIntelSourceTests: XCTestCase {
    func test_Hub登録済みならHubが唯一の取得元() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: true, isDirectDownloadEnabled: false),
            .hub
        )
    }

    /// The opt-in is not offered while enrolled, but a value left over from
    /// before enrolment must not resurrect the third-party path.
    func test_Hub登録済みなら単独取得の設定が残っていてもHub() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: true, isDirectDownloadEnabled: true),
            .hub
        )
    }

    func test_Hubなしでopt_inしていれば単独取得() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: false, isDirectDownloadEnabled: true),
            .directDownload
        )
    }

    /// Not "no threats" -- nobody looked. The screen has to say which.
    func test_Hubなしでopt_inしていなければ何も取得しない() {
        XCTAssertEqual(
            ThreatIntelSource.decide(isEnrolledWithHub: false, isDirectDownloadEnabled: false),
            .none
        )
    }

    /// The rule has no way to see reachability, so no amount of Hub downtime
    /// can change its answer. Pinned by the signature itself: there is no
    /// parameter for it, and adding one would fail to compile here.
    func test_到達性は判断材料に入らない() {
        let enrolled = [true, false]
        let optedIn = [true, false]
        for hub in enrolled {
            for opt in optedIn {
                let first = ThreatIntelSource.decide(
                    isEnrolledWithHub: hub, isDirectDownloadEnabled: opt
                )
                let second = ThreatIntelSource.decide(
                    isEnrolledWithHub: hub, isDirectDownloadEnabled: opt
                )
                XCTAssertEqual(first, second, "同じ入力なら常に同じ取得元")
                if hub { XCTAssertEqual(first, .hub) }
            }
        }
    }
}
