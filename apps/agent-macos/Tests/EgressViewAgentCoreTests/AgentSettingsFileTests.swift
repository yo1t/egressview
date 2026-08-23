import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentSettingsFileTests: XCTestCase {
    func testCarriesNoSecret() throws {
        // The point of the file is that its owner can read it before handing it
        // to anyone. A settings file that carries the Hub credential turns
        // "copy my preferences" into "copy my access".
        let file = AgentSettingsFile(
            retentionDays: 30,
            hubDeliveryEnabled: true,
            readServerNameFromHandshake: true,
            automaticUpdateChecks: true,
            language: "japanese"
        )
        let text = String(data: try file.encoded(), encoding: .utf8) ?? ""
        for forbidden in ["credential", "token", "secret", "password", "key", "Bearer"] {
            XCTAssertFalse(
                text.lowercased().contains(forbidden.lowercased()),
                "the settings file carries \(forbidden): \(text)"
            )
        }
    }

    func testASecretInTheFileIsNotImported() throws {
        // A hand-edited or hostile file must not be able to introduce one
        // either -- unknown keys are dropped on the way in.
        let json = """
        {"version": 1, "retentionDays": 30, "hubCredential": "abc123",
         "launchAtLogin": true}
        """
        let decoded = try AgentSettingsFile.decode(Data(json.utf8))
        let text = String(data: try decoded.encoded(), encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("abc123"))
        XCTAssertFalse(text.contains("launchAtLogin"))
        XCTAssertEqual(decoded.retentionDays, 30)
    }

    func testRoundTripsEverythingItCarries() throws {
        let file = AgentSettingsFile(
            retentionDays: 7,
            hubDeliveryEnabled: false,
            readServerNameFromHandshake: true,
            automaticUpdateChecks: false,
            language: "english"
        )
        XCTAssertEqual(try AgentSettingsFile.decode(try file.encoded()), file)
    }

    func testAFileFromALaterVersionStillAppliesWhatItShares() throws {
        // The Windows agent will not have every setting this one has, and a
        // later version will have settings this one does not. Failing whole
        // would make the file useless in exactly the case it exists for.
        let json = """
        {"version": 99, "retentionDays": 14, "somethingNewer": {"a": 1}}
        """
        let decoded = try AgentSettingsFile.decode(Data(json.utf8))
        XCTAssertEqual(decoded.retentionDays, 14)
        XCTAssertEqual(decoded.presentFields, [.retentionDays])
    }

    func testAnUnsupportedRetentionIsDroppedRatherThanClamped() throws {
        // Clamping 45 days to 30 and reporting success would tell the user
        // their machine keeps a period it does not keep.
        let file = AgentSettingsFile(retentionDays: 45)
        let (settings, ignored) = file.validated()
        XCTAssertNil(settings.retentionDays)
        XCTAssertEqual(ignored, [.retentionDays])
    }

    func testCarriesOnlyTheSettingsItIsAllowedTo() {
        // Pinned deliberately. Three kinds of setting are excluded and each
        // exclusion is a decision, not an omission: the Hub credential and its
        // address (a secret), launching at login (a registration with macOS),
        // and third-party geo lookup (the one setting that would send the
        // destinations this agent watches to somebody else). A file must not be
        // able to make any of those changes on someone's behalf.
        XCTAssertEqual(
            AgentSettingsFile.Field.allCases.map(\.rawValue),
            [
                "retentionDays", "hubDeliveryEnabled",
                "readServerNameFromHandshake", "automaticUpdateChecks", "language",
            ]
        )
    }

    func testAnUnknownLanguageIsDropped() throws {
        let (settings, ignored) = AgentSettingsFile(language: "klingon").validated()
        XCTAssertNil(settings.language)
        XCTAssertEqual(ignored, [.language])
    }

    func testAnEmptyFileChangesNothing() throws {
        let decoded = try AgentSettingsFile.decode(Data(#"{"version": 1}"#.utf8))
        XCTAssertTrue(decoded.presentFields.isEmpty)
        let (settings, ignored) = decoded.validated()
        XCTAssertTrue(settings.presentFields.isEmpty)
        XCTAssertTrue(ignored.isEmpty)
    }

    func testTheSuggestedNameIsSortableAndSaysWhatItIs() {
        let name = AgentSettingsFile.suggestedFileName(
            now: Date(timeIntervalSince1970: 1_800_000_000)
        )
        XCTAssertEqual(name, "egressview-agent-settings-20270115-080000.json")
    }
}
