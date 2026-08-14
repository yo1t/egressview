import Foundation
import XCTest
@testable import EgressViewAgentCore

/// The manifest and detached signature actually served by the distribution
/// host on 2026-08-14, signed by the KMS release key.
///
/// A hand-made fixture signed by a throwaway key would prove that the code
/// verifies *a* signature. This fixture proves it verifies *ours*, against the
/// same key whose fingerprint is published in DNS.
private enum PublishedFixture {
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
}

private struct StubTransport: AgentUpdateTransport {
    let manifest: Data
    let signature: Data
    var status: Int = 200
    var failure: (any Error)?

    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if let failure { throw failure }
        let url = try XCTUnwrap(request.url)
        let body = url.lastPathComponent == "manifest.json.sig" ? signature : manifest
        let response = HTTPURLResponse(
            url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (body, response)
    }
}

private func makeChecker(
    currentVersion: String,
    arch: String = "arm64",
    transport: some AgentUpdateTransport
) -> AgentUpdateChecker {
    AgentUpdateChecker(
        origin: URL(string: "https://dl.egressview.com")!,
        platform: "macos",
        arch: arch,
        currentVersion: currentVersion,
        osVersion: "15.5",
        transport: transport
    )
}

final class AgentReleaseKeyTests: XCTestCase {
    func testEmbeddedKeyMatchesThePublishedFingerprint() {
        XCTAssertEqual(AgentReleaseKey.fingerprint, AgentReleaseKey.publishedFingerprint)
        XCTAssertTrue(AgentReleaseKey.matchesPublishedFingerprint)
    }

    func testFingerprintIsTakenOverTheSpkiEncoding() {
        // The value published in the DNS TXT record and in SECURITY.md.
        XCTAssertEqual(
            AgentReleaseKey.fingerprint,
            "SHA256:6288265bd746d230a3637e3a520e2335f48dc939a4d76d7b05c44ea5baf3eccc"
        )
    }
}

final class AgentSemanticVersionTests: XCTestCase {
    func testComparesNumericallyRatherThanLexically() throws {
        let older = try XCTUnwrap(AgentSemanticVersion("0.9.0"))
        let newer = try XCTUnwrap(AgentSemanticVersion("0.10.0"))
        XCTAssertTrue(newer > older)
    }

    func testPrereleasePrecedesItsRelease() throws {
        let beta = try XCTUnwrap(AgentSemanticVersion("0.2.0-beta.1"))
        let release = try XCTUnwrap(AgentSemanticVersion("0.2.0"))
        XCTAssertTrue(beta < release)
    }

    func testRejectsMalformedVersions() {
        for text in ["", "0.2", "v0.2.0", "0.2.0.1", "0.x.0"] {
            XCTAssertNil(AgentSemanticVersion(text), text)
        }
    }
}

final class AgentUpdateCheckerTests: XCTestCase {
    func testAcceptsThePublishedManifestAndOffersTheNewerVersion() async throws {
        let checker = makeChecker(
            currentVersion: "0.1.15",
            transport: StubTransport(
                manifest: PublishedFixture.manifest, signature: PublishedFixture.signature
            )
        )
        guard case let .updateAvailable(version, package) = try await checker.check() else {
            return XCTFail("expected an available update")
        }
        XCTAssertEqual(version, "0.1.16")
        XCTAssertEqual(package.arch, "arm64")
        XCTAssertEqual(package.packageType, "dmg")
        XCTAssertEqual(package.url.scheme, "https")
        XCTAssertEqual(
            package.sha256,
            "4bfe51311116a909ee3f0b8da706c121db5b01ffced00c5a3678cb449b8d0db2"
        )
    }

    func testRejectsATamperedManifestSignedForDifferentBytes() async {
        var tampered = PublishedFixture.manifest
        let text = String(data: tampered, encoding: .utf8)!.replacingOccurrences(
            of: "dl.egressview.com", with: "dl.egressview.example"
        )
        tampered = Data(text.utf8)
        let checker = makeChecker(
            currentVersion: "0.1.15",
            transport: StubTransport(manifest: tampered, signature: PublishedFixture.signature)
        )
        await XCTAssertThrowsErrorAsync(try await checker.check()) { error in
            XCTAssertEqual(error as? AgentUpdateError, .signatureInvalid)
        }
    }

    func testRejectsAValidlySignedManifestPairedWithAnotherSignature() async {
        let checker = makeChecker(
            currentVersion: "0.1.15",
            transport: StubTransport(
                manifest: PublishedFixture.manifest,
                signature: Data(repeating: 0, count: 64)
            )
        )
        await XCTAssertThrowsErrorAsync(try await checker.check()) { error in
            XCTAssertEqual(error as? AgentUpdateError, .signatureInvalid)
        }
    }

    func testRefusesToWalkBackwardsToAnOlderPublishedVersion() async throws {
        let checker = makeChecker(
            currentVersion: "0.2.0",
            transport: StubTransport(
                manifest: PublishedFixture.manifest, signature: PublishedFixture.signature
            )
        )
        let decision = try await checker.check()
        XCTAssertEqual(decision, .upToDate)
    }

    func testTreatsTheSameVersionAsUpToDate() async throws {
        let checker = makeChecker(
            currentVersion: "0.1.16",
            transport: StubTransport(
                manifest: PublishedFixture.manifest, signature: PublishedFixture.signature
            )
        )
        let decision = try await checker.check()
        XCTAssertEqual(decision, .upToDate)
    }

    func testReportsWhenNoPackageMatchesThisArchitecture() async {
        let checker = makeChecker(
            currentVersion: "0.1.15",
            arch: "x64",
            transport: StubTransport(
                manifest: PublishedFixture.manifest, signature: PublishedFixture.signature
            )
        )
        await XCTAssertThrowsErrorAsync(try await checker.check()) { error in
            XCTAssertEqual(error as? AgentUpdateError, .noPackageForArch("x64"))
        }
    }

    func testSurfacesAnHttpFailureRatherThanTreatingItAsUpToDate() async {
        let checker = makeChecker(
            currentVersion: "0.1.15",
            transport: StubTransport(
                manifest: PublishedFixture.manifest,
                signature: PublishedFixture.signature,
                status: 404
            )
        )
        await XCTAssertThrowsErrorAsync(try await checker.check()) { error in
            XCTAssertEqual(error as? AgentUpdateError, .httpStatus(404))
        }
    }

    func testSendsOnlyAVersionBearingUserAgentAndNoIdentifier() {
        let checker = makeChecker(
            currentVersion: "0.2.0",
            transport: StubTransport(
                manifest: PublishedFixture.manifest, signature: PublishedFixture.signature
            )
        )
        XCTAssertEqual(checker.userAgent, "EgressViewAgent/0.2.0 (macOS 15.5)")
        // Anything resembling a per-install identifier would make the access log
        // a device tracker rather than a version count.
        XCTAssertFalse(checker.userAgent.contains("-"))
        XCTAssertEqual(checker.userAgent.filter { $0 == "/" }.count, 1)
    }

    func testIgnoresUnknownManifestFieldsInsteadOfRefusingToUpdate() throws {
        // Must-ignore: a publisher adding a field cannot be allowed to stop
        // existing agents from ever seeing an update again.
        let json = Data("""
        {"schemaVersion":1,"platform":"macos","version":"0.3.0","channel":"stable",
         "packages":[{"arch":"arm64","packageType":"dmg","minimumOS":"14.0",
         "url":"https://dl.egressview.com/macos/a.dmg","sha256":"ab","sizeBytes":1}]}
        """.utf8)
        let manifest = try JSONDecoder().decode(AgentUpdateManifest.self, from: json)
        XCTAssertEqual(manifest.version, "0.3.0")
        XCTAssertEqual(manifest.packages.first?.arch, "arm64")
    }
}

final class AgentUpdatePreferencesTests: XCTestCase {
    private func makePreferences() throws -> (AgentUpdatePreferences, UserDefaults, String) {
        let suite = "com.egressview.agent.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        return (AgentUpdatePreferences(defaults: defaults), defaults, suite)
    }

    func testUpdateCheckingIsOnByDefaultUnlikeDataDelivery() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(preferences.isEnabled)
        XCTAssertTrue(preferences.shouldCheck(now: Date()))
    }

    func testDisablingStopsTheCheckEntirely() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        preferences.isEnabled = false
        XCTAssertFalse(preferences.shouldCheck(now: Date()))
    }

    func testOfflineModeStopsTheCheckEvenWhenEnabled() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertTrue(preferences.isEnabled)
        XCTAssertFalse(preferences.shouldCheck(now: Date(), offline: true))
    }

    func testChecksAtMostOncePerDay() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        preferences.lastCheckedAt = now
        XCTAssertFalse(preferences.shouldCheck(now: now.addingTimeInterval(23 * 3600)))
        XCTAssertTrue(preferences.shouldCheck(now: now.addingTimeInterval(24 * 3600)))
    }

    func testABackwardsClockDoesNotSuppressChecksUntilItCatchesUp() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        preferences.lastCheckedAt = now.addingTimeInterval(30 * 24 * 3600)
        XCTAssertTrue(preferences.shouldCheck(now: now))
    }
}

/// Opt-in check against the real distribution host:
/// `RUN_AGENT_UPDATE_LIVE=1 swift test --filter AgentUpdateLive`
///
/// The unit tests above pin bytes captured on one day. This one answers a
/// different question -- whether the host is still serving something this build
/// will accept -- and it is kept out of the default run because a network
/// failure is not a defect in this code.
final class AgentUpdateLiveTests: XCTestCase {
    func testTheLiveHostServesAManifestThisBuildTrusts() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["RUN_AGENT_UPDATE_LIVE"] == "1",
            "set RUN_AGENT_UPDATE_LIVE=1 to reach dl.egressview.com"
        )
        let checker = AgentUpdateChecker(
            currentVersion: "0.0.1",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString
        )
        guard case let .updateAvailable(version, package) = try await checker.check() else {
            return XCTFail("expected the live host to publish a version newer than 0.0.1")
        }
        XCTAssertFalse(version.isEmpty)
        XCTAssertEqual(package.url.host, "dl.egressview.com")
        XCTAssertEqual(package.sha256.count, 64)
    }
}

func XCTAssertThrowsErrorAsync<T>(
    _ expression: @autoclosure () async throws -> T,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ handler: (any Error) -> Void
) async {
    do {
        _ = try await expression()
        XCTFail("expected an error", file: file, line: line)
    } catch {
        handler(error)
    }
}
