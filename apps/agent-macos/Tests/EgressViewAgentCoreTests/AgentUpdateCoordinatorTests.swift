import CryptoKit
import Foundation
import XCTest
@testable import EgressViewAgentCore

private let releaseKeyPayload = Data("egressview agent 0.2.0".utf8)

private struct ManifestTransport: AgentUpdateTransport {
    let manifest: Data
    let signature: Data

    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let url = request.url!
        let body = url.lastPathComponent == "manifest.json.sig" ? signature : manifest
        return (body, HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct FailingTransport: AgentUpdateTransport {
    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        throw AgentUpdateError.transport("the network is down")
    }
}

private struct PayloadDownloadTransport: AgentUpdateDownloadTransport {
    let payload: Data

    func download(_ request: URLRequest) async throws -> (URL, HTTPURLResponse) {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-coordinator-\(UUID().uuidString)")
        try payload.write(to: file)
        return (file, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
    }
}

private struct StubVerifierRunner: AgentCommandRunning {
    var accept = true

    func run(_ executable: String, _ arguments: [String]) throws -> AgentCommandResult {
        if executable.hasSuffix("spctl") {
            return AgentCommandResult(
                exitCode: accept ? 0 : 3,
                standardOutput: "",
                standardError: accept ? "accepted" : "source=Unnotarized Developer ID"
            )
        }
        return AgentCommandResult(
            exitCode: 0, standardOutput: "", standardError: "TeamIdentifier=TEAMID1234"
        )
    }
}

/// The real published manifest and its real signature. Only the release key
/// can produce a valid pair, so tests that need a manifest the agent will
/// accept use this one, and tests that need a rejected manifest build their own
/// -- which is by construction unsigned.
private enum Fixture {
    static let manifest = Data(base64Encoded: """
    ewogICJzY2hlbWFWZXJzaW9uIjogMSwKICAicGxhdGZvcm0iOiAibWFjb3MiLAogICJ2ZXJzaW9uIjogIjAuMS4xNiIsCiAg\
    InJlbGVhc2VkQXQiOiAiMjAyNi0wOC0xNFQwMDo0MTowNy4zMzZaIiwKICAicGFja2FnZXMiOiBbCiAgICB7CiAgICAgICJh\
    cmNoIjogImFybTY0IiwKICAgICAgInBhY2thZ2VUeXBlIjogImRtZyIsCiAgICAgICJ1cmwiOiAiaHR0cHM6Ly9kbC5lZ3Jl\
    c3N2aWV3LmNvbS9tYWNvcy9lZ3Jlc3N2aWV3LWFnZW50LTAuMS4xNi5kbWciLAogICAgICAic2hhMjU2IjogIjRiZmU1MTMx\
    MTExNmE5MDllZTNmMGI4ZGE3MDZjMTIxZGI1YjAxZmZjZWQwMGM1YTM2NzhjYjQ0OWI4ZDBkYjIiLAogICAgICAic2l6ZUJ5\
    dGVzIjogNTE1MDI0CiAgICB9CiAgXQp9Cg==
    """)!

    static let signature = Data(base64Encoded:
        "EhkcoP7hlI7tytVyiLGv7/G4D9BZ6hqlySNnPCu8hRx++ho6a1OYL+zjiaFMOvUtLZ9z2W8eLEfnXFN48HMaCQ=="
    )!

    /// A well-formed manifest for an arbitrary payload. It carries no valid
    /// signature and must therefore never get past the checker.
    static func manifestDescribing(_ payload: Data, version: String) -> Data {
        let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        return Data("""
        {"schemaVersion":1,"platform":"macos","version":"\(version)","packages":[\
        {"arch":"arm64","packageType":"dmg",\
        "url":"https://dl.egressview.com/macos/egressview-agent-\(version).dmg",\
        "sha256":"\(digest)","sizeBytes":\(payload.count)}]}
        """.utf8)
    }
}

private func makePreferences() throws -> (AgentUpdatePreferences, UserDefaults, String) {
    let suite = "com.egressview.agent.tests.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    return (AgentUpdatePreferences(defaults: defaults), defaults, suite)
}

private func makeChecker(
    currentVersion: String,
    transport: some AgentUpdateTransport
) -> AgentUpdateChecker {
    AgentUpdateChecker(
        platform: "macos", arch: "arm64",
        currentVersion: currentVersion, osVersion: "15.5", transport: transport
    )
}

final class AgentUpdateCoordinatorTests: XCTestCase {
    func testReportsUpToDateAndAdvancesTheDailyClock() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(
                currentVersion: "0.2.0",
                transport: ManifestTransport(manifest: Fixture.manifest, signature: Fixture.signature)
            ),
            preferences: preferences,
            clock: { now }
        )

        let state = await coordinator.runIfDue()
        XCTAssertEqual(state, .upToDate(checkedAt: now))
        XCTAssertEqual(preferences.lastCheckedAt, now)
    }

    /// End to end on real artefacts: the published manifest, its real
    /// signature, and the real package those bytes describe. The package is a
    /// build output, so this skips where it is absent rather than weakening the
    /// assertion to something a fake payload could satisfy.
    func testCarriesAnAvailableUpdateThroughToAVerifiedPackage() async throws {
        let package = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // EgressViewAgentCoreTests
            .deletingLastPathComponent()   // Tests
            .deletingLastPathComponent()   // agent-macos
            .appendingPathComponent("dist/egressview-agent-0.1.16.dmg")
        try XCTSkipUnless(
            FileManager.default.fileExists(atPath: package.path),
            "build dist/egressview-agent-0.1.16.dmg to run the end-to-end update path"
        )
        let payload = try Data(contentsOf: package)

        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(
                currentVersion: "0.1.15",
                transport: ManifestTransport(manifest: Fixture.manifest, signature: Fixture.signature)
            ),
            downloader: AgentUpdateDownloader(transport: PayloadDownloadTransport(payload: payload)),
            verifier: AgentPackageVerifier(
                currentTeamIdentifier: "TEAMID1234",
                resolvePackageIdentity: { _ in "TEAMID1234" }
            ),
            preferences: preferences,
            clock: { now }
        )

        guard case let .readyToInstall(version, file) = await coordinator.runNow() else {
            return XCTFail("expected a downloaded package")
        }
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(version, "0.1.16")
        // The hash in the signed manifest is what the downloaded bytes were
        // checked against; nothing here trusts the file name.
        XCTAssertEqual(
            try AgentUpdateDownloader.sha256Hex(of: file),
            "4bfe51311116a909ee3f0b8da706c121db5b01ffced00c5a3678cb449b8d0db2"
        )
        XCTAssertEqual(preferences.lastCheckedAt, now)
    }

    func testStopsBeforeDownloadingWhenTheManifestIsNotSignedByTheReleaseKey() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let payload = releaseKeyPayload
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(
                currentVersion: "0.2.0",
                transport: ManifestTransport(
                    // Well-formed, newer, and describing a real download -- but
                    // the signature belongs to different bytes.
                    manifest: Fixture.manifestDescribing(payload, version: "0.3.0"),
                    signature: Fixture.signature
                )
            ),
            downloader: AgentUpdateDownloader(transport: PayloadDownloadTransport(payload: payload)),
            verifier: AgentPackageVerifier(
                currentTeamIdentifier: "TEAMID1234",
                resolvePackageIdentity: { _ in "TEAMID1234" }
            ),
            preferences: preferences
        )

        let state = await coordinator.runNow()
        XCTAssertEqual(
            state,
            .failed("The update information was not signed by the EgressView release key.")
        )
        XCTAssertNil(preferences.lastCheckedAt)
    }

    /// The agent downloads the package after all.
    ///
    /// Handing the user a disk image could not work: macOS marks everything a
    /// sandboxed application writes and refuses to *launch* an app taken from
    /// it. Installing a package is not launching an app -- `installd` does it,
    /// and a package carrying the same mark installs normally, measured on a
    /// real machine. So a download failure has to surface as a failure rather
    /// than be skipped.
    func testReportsAFailureWhenThePackageCannotBeDownloaded() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        final class CountingTransport: AgentUpdateDownloadTransport, @unchecked Sendable {
            var calls = 0
            func download(_ request: URLRequest) async throws -> (URL, HTTPURLResponse) {
                calls += 1
                throw AgentUpdateError.transport("the package must not be downloaded")
            }
        }
        let transport = CountingTransport()
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(
                currentVersion: "0.1.15",
                transport: ManifestTransport(manifest: Fixture.manifest, signature: Fixture.signature)
            ),
            downloader: AgentUpdateDownloader(transport: transport),
            preferences: preferences
        )

        guard case let .failed(message) = await coordinator.runNow() else {
            return XCTFail("expected a failure")
        }
        XCTAssertEqual(transport.calls, 1, "パッケージを1回取得しようとする")
        XCTAssertTrue(message.contains("Could not reach the update service"), message)
        XCTAssertNil(preferences.lastCheckedAt, "答えが得られていないので日次時計は進めない")
    }

    func testDoesNotAdvanceTheDailyClockWhenTheCheckFails() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(currentVersion: "0.2.0", transport: FailingTransport()),
            preferences: preferences,
            clock: { now }
        )

        let state = await coordinator.runIfDue()
        XCTAssertEqual(state, .failed("Could not reach the update service: the network is down"))
        // A failed check must be retried before tomorrow.
        XCTAssertNil(preferences.lastCheckedAt)
        XCTAssertEqual(preferences.lastAttemptedAt, now)
    }

    func testAFailedCheckIsRetriedWithinTheHourButNotOnEveryLaunch() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let start = Date()
        preferences.lastAttemptedAt = start

        XCTAssertFalse(preferences.shouldCheck(now: start.addingTimeInterval(59 * 60)))
        XCTAssertTrue(preferences.shouldCheck(now: start.addingTimeInterval(61 * 60)))
    }

    func testDoesNothingWhenCheckingIsDisabledOrOffline() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(currentVersion: "0.2.0", transport: FailingTransport()),
            preferences: preferences
        )

        let offlineState = await coordinator.runIfDue(offline: true)
        XCTAssertEqual(offlineState, .disabled)
        preferences.isEnabled = false
        let disabledState = await coordinator.runIfDue()
        XCTAssertEqual(disabledState, .disabled)
        XCTAssertNil(preferences.lastAttemptedAt)
    }

    func testSkipsAnAlreadyCompletedCheckUntilTheNextDay() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        preferences.lastCheckedAt = now
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(currentVersion: "0.2.0", transport: FailingTransport()),
            preferences: preferences,
            clock: { now.addingTimeInterval(3600) }
        )
        let state = await coordinator.runIfDue()
        XCTAssertEqual(state, .notDue)
    }

    func testExplicitCheckNowIgnoresTheSchedule() async throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        preferences.lastCheckedAt = now
        let coordinator = AgentUpdateCoordinator(
            checker: makeChecker(
                currentVersion: "0.2.0",
                transport: ManifestTransport(manifest: Fixture.manifest, signature: Fixture.signature)
            ),
            preferences: preferences,
            clock: { now }
        )
        // Someone waiting on a "check now" button gets an answer, not silence.
        let state = await coordinator.runNow()
        XCTAssertEqual(state, .upToDate(checkedAt: now))
    }

    func testFailureMessagesSayWhatHappenedAndNotJustAnErrorCase() {
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(AgentUpdateError.signatureInvalid),
            "The update information was not signed by the EgressView release key."
        )
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(
                AgentPackageVerificationError.teamIdentifierMismatch(
                    expected: "AAAA", actual: "BBBB"
                )
            ),
            "The update was signed by a different developer (BBBB) than the copy already installed (AAAA)."
        )
        // The sandbox made the old spctl check impossible, so these are the
        // states the in-process check can now report. Each has to say what
        // happened, not just which case it was.
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(AgentPackageVerificationError.signatureInvalid(-67061)),
            "The downloaded package's signature did not verify (code -67061)."
        )
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(AgentPackageVerificationError.teamIdentifierMissing),
            "The downloaded package is not signed by a developer this Mac can identify."
        )
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(AgentPackageVerificationError.packageUnreadable),
            "The downloaded package could not be read for verification."
        )
        XCTAssertEqual(
            AgentUpdateCoordinator.describe(AgentUpdateError.httpStatus(503)),
            "The update service returned HTTP 503."
        )
    }
}
