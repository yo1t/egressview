import CryptoKit
import Foundation
import XCTest
@testable import EgressViewAgentCore

private struct FileTransport: AgentUpdateDownloadTransport {
    let payload: Data
    var status: Int = 200

    func download(_ request: URLRequest) async throws -> (URL, HTTPURLResponse) {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-test-\(UUID().uuidString)")
        try payload.write(to: file)
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
        )!
        return (file, response)
    }
}

private func makePackage(for payload: Data, sha256: String? = nil, size: Int? = nil) -> AgentUpdatePackage {
    let digest = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
    let json = """
    {"arch":"arm64","packageType":"dmg",
     "url":"https://dl.egressview.com/macos/egressview-agent-0.2.0.dmg",
     "sha256":"\(sha256 ?? digest)","sizeBytes":\(size ?? payload.count)}
    """
    return try! JSONDecoder().decode(AgentUpdatePackage.self, from: Data(json.utf8))
}

final class AgentUpdateDownloaderTests: XCTestCase {
    func testKeepsAPackageWhoseHashAndSizeMatchTheSignedManifest() async throws {
        let payload = Data("egressview agent package".utf8)
        let downloader = AgentUpdateDownloader(transport: FileTransport(payload: payload))
        let file = try await downloader.download(makePackage(for: payload), userAgent: "test")
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(try Data(contentsOf: file), payload)
        XCTAssertEqual(file.pathExtension, "dmg")
    }

    func testRejectsAndDeletesAPackageWhoseHashDoesNotMatch() async {
        let payload = Data("tampered payload".utf8)
        let downloader = AgentUpdateDownloader(transport: FileTransport(payload: payload))
        let wrongHash = String(repeating: "ab", count: 32)
        var leaked: URL?
        do {
            leaked = try await downloader.download(
                makePackage(for: payload, sha256: wrongHash), userAgent: "test"
            )
            XCTFail("expected a checksum failure")
        } catch let error as AgentUpdateDownloadError {
            guard case let .checksumMismatch(expected, _) = error else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(expected, wrongHash)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
        // A rejected package must not remain on disk where something else could
        // pick it up and install it.
        if let leaked { XCTAssertFalse(FileManager.default.fileExists(atPath: leaked.path)) }
    }

    func testRejectsATruncatedTransferBeforeHashing() async {
        let payload = Data("short".utf8)
        let downloader = AgentUpdateDownloader(transport: FileTransport(payload: payload))
        do {
            _ = try await downloader.download(
                makePackage(for: payload, size: payload.count + 100), userAgent: "test"
            )
            XCTFail("expected a size failure")
        } catch let error as AgentUpdateDownloadError {
            XCTAssertEqual(error, .sizeMismatch(expected: payload.count + 100, actual: payload.count))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRejectsANonSuccessResponse() async {
        let payload = Data("body".utf8)
        let downloader = AgentUpdateDownloader(
            transport: FileTransport(payload: payload, status: 403)
        )
        do {
            _ = try await downloader.download(makePackage(for: payload), userAgent: "test")
            XCTFail("expected an HTTP failure")
        } catch let error as AgentUpdateDownloadError {
            XCTAssertEqual(error, .httpStatus(403))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testRejectsAMalformedChecksumWithoutDownloading() async {
        let payload = Data("body".utf8)
        let downloader = AgentUpdateDownloader(transport: FileTransport(payload: payload))
        do {
            _ = try await downloader.download(makePackage(for: payload, sha256: "nothex"), userAgent: "test")
            XCTFail("expected a malformed checksum failure")
        } catch let error as AgentUpdateDownloadError {
            XCTAssertEqual(error, .malformedChecksum("nothex"))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testStreamedHashMatchesAOneShotHash() throws {
        let file = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-test-\(UUID().uuidString)")
        // Larger than the 1 MiB read chunk, so the streaming path is exercised.
        let payload = Data((0..<(3 * 1024 * 1024)).map { UInt8($0 % 251) })
        try payload.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        let expected = SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(try AgentUpdateDownloader.sha256Hex(of: file), expected)
    }
}

private struct StubRunner: AgentCommandRunning {
    var spctl = AgentCommandResult(exitCode: 0, standardOutput: "", standardError: "accepted")
    var codesign: AgentCommandResult

    func run(_ executable: String, _ arguments: [String]) throws -> AgentCommandResult {
        executable.hasSuffix("spctl") ? spctl : codesign
    }
}

private func codesignOutput(team: String) -> AgentCommandResult {
    AgentCommandResult(
        exitCode: 0,
        standardOutput: "",
        standardError: """
        Executable=/Volumes/EgressView/EgressView Agent.app
        Identifier=com.egressview.agent
        TeamIdentifier=\(team)
        """
    )
}

final class AgentPackageVerifierTests: XCTestCase {
    private let package = URL(fileURLWithPath: "/tmp/egressview-agent-0.2.0.dmg")

    func testAcceptsAPackageSignedByTheSameTeamAsTheRunningBuild() throws {
        let verifier = AgentPackageVerifier(
            runner: StubRunner(codesign: codesignOutput(team: "TEAMID1234")),
            currentTeamIdentifier: "TEAMID1234"
        )
        XCTAssertNoThrow(try verifier.verify(packageAt: package))
    }

    func testRejectsAPackageSignedByADifferentTeam() {
        let verifier = AgentPackageVerifier(
            runner: StubRunner(codesign: codesignOutput(team: "SOMEONEELSE")),
            currentTeamIdentifier: "TEAMID1234"
        )
        XCTAssertThrowsError(try verifier.verify(packageAt: package)) { error in
            XCTAssertEqual(
                error as? AgentPackageVerificationError,
                .teamIdentifierMismatch(expected: "TEAMID1234", actual: "SOMEONEELSE")
            )
        }
    }

    func testRejectsAPackageGatekeeperWillNotAccept() {
        let verifier = AgentPackageVerifier(
            runner: StubRunner(
                spctl: AgentCommandResult(
                    exitCode: 3, standardOutput: "", standardError: "source=Unnotarized Developer ID"
                ),
                codesign: codesignOutput(team: "TEAMID1234")
            ),
            currentTeamIdentifier: "TEAMID1234"
        )
        XCTAssertThrowsError(try verifier.verify(packageAt: package)) { error in
            XCTAssertEqual(
                error as? AgentPackageVerificationError,
                .notarisationRejected("source=Unnotarized Developer ID")
            )
        }
    }

    func testRefusesToVerifyWhenTheRunningBuildHasNoTeamIdentifier() {
        // A development build must not become the one that installs anything it
        // is handed.
        let verifier = AgentPackageVerifier(
            runner: StubRunner(codesign: codesignOutput(team: "TEAMID1234")),
            currentTeamIdentifier: nil
        )
        XCTAssertThrowsError(try verifier.verify(packageAt: package)) { error in
            XCTAssertEqual(error as? AgentPackageVerificationError, .runningBuildIsNotTeamSigned)
        }
    }

    func testTreatsAnAdHocSignatureAsHavingNoTeamIdentifier() {
        XCTAssertNil(AgentPackageVerifier.teamIdentifier(inCodesignOutput: "TeamIdentifier=not set"))
        XCTAssertNil(AgentPackageVerifier.teamIdentifier(inCodesignOutput: "Identifier=com.example"))
        XCTAssertEqual(
            AgentPackageVerifier.teamIdentifier(inCodesignOutput: "TeamIdentifier=ABCDE12345"),
            "ABCDE12345"
        )
    }
}
