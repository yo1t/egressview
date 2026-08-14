import Foundation
import Security

public enum AgentPackageVerificationError: Error, Equatable {
    case runningBuildIsNotTeamSigned
    case notarisationRejected(String)
    case teamIdentifierMissing
    case teamIdentifierMismatch(expected: String, actual: String)
}

public struct AgentCommandResult: Equatable, Sendable {
    public let exitCode: Int32
    public let standardOutput: String
    public let standardError: String

    public init(exitCode: Int32, standardOutput: String, standardError: String) {
        self.exitCode = exitCode
        self.standardOutput = standardOutput
        self.standardError = standardError
    }
}

public protocol AgentCommandRunning: Sendable {
    func run(_ executable: String, _ arguments: [String]) throws -> AgentCommandResult
}

public struct AgentProcessCommandRunner: AgentCommandRunning {
    public init() {}

    public func run(_ executable: String, _ arguments: [String]) throws -> AgentCommandResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let out = Pipe()
        let err = Pipe()
        process.standardOutput = out
        process.standardError = err
        try process.run()
        // Read before waiting: a full pipe buffer would otherwise deadlock.
        let outData = out.fileHandleForReading.readDataToEndOfFile()
        let errData = err.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return AgentCommandResult(
            exitCode: process.terminationStatus,
            standardOutput: String(decoding: outData, as: UTF8.self),
            standardError: String(decoding: errData, as: UTF8.self)
        )
    }
}

/// Reads the Team ID of the code that is running right now.
public enum AgentCodeIdentity {
    public static func currentTeamIdentifier() -> String? {
        var code: SecCode?
        guard SecCodeCopySelf(SecCSFlags(), &code) == errSecSuccess, let code else { return nil }
        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let staticCode else { return nil }
        var information: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &information) == errSecSuccess,
              let details = information as? [String: Any] else { return nil }
        return details[kSecCodeInfoTeamIdentifier as String] as? String
    }

    public static func isAppSandboxEnabled() -> Bool {
        guard let task = SecTaskCreateFromSelf(nil),
              let value = SecTaskCopyValueForEntitlement(
                task,
                "com.apple.security.app-sandbox" as CFString,
                nil
              ) else {
            return false
        }
        return value as? Bool == true
    }
}

/// Checks a downloaded package before it is offered to the user.
///
/// The manifest signature already proves the bytes are the ones we published,
/// so this is a second, independent question: does macOS itself consider this
/// package acceptable, and was it signed by the same developer as the build
/// currently running?
///
/// **The expected Team ID is read from the running build rather than compiled
/// in.** An update must come from whoever signed what is already installed.
/// That is the property worth enforcing, and it means no signing identity has
/// to be written into the source.
public struct AgentPackageVerifier: Sendable {
    private let runner: any AgentCommandRunning
    private let currentTeamIdentifier: String?

    public init(
        runner: any AgentCommandRunning = AgentProcessCommandRunner(),
        currentTeamIdentifier: String? = AgentCodeIdentity.currentTeamIdentifier()
    ) {
        self.runner = runner
        self.currentTeamIdentifier = currentTeamIdentifier
    }

    public func verify(packageAt url: URL) throws {
        // A development build has no Team ID to compare against. Refusing here
        // is deliberate: silently skipping the check would make the weakest
        // build the one with the least protection.
        guard let expected = currentTeamIdentifier, !expected.isEmpty else {
            throw AgentPackageVerificationError.runningBuildIsNotTeamSigned
        }

        // Gatekeeper's own assessment. This is what would happen when the user
        // opens the file, asked in advance so a rejection is reported as a
        // failed update rather than a confusing dialog.
        let assessment = try runner.run("/usr/sbin/spctl", [
            "--assess", "--type", "open",
            "--context", "context:primary-signature",
            "--verbose=4", url.path,
        ])
        guard assessment.exitCode == 0 else {
            let reason = assessment.standardError.isEmpty
                ? assessment.standardOutput
                : assessment.standardError
            throw AgentPackageVerificationError.notarisationRejected(
                reason.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }

        let signature = try runner.run("/usr/bin/codesign", ["-dv", "--verbose=4", url.path])
        guard let actual = Self.teamIdentifier(inCodesignOutput: signature.standardError + signature.standardOutput) else {
            throw AgentPackageVerificationError.teamIdentifierMissing
        }
        guard actual == expected else {
            throw AgentPackageVerificationError.teamIdentifierMismatch(expected: expected, actual: actual)
        }
    }

    /// `codesign -dv` writes its report to standard error, one `key=value` per
    /// line.
    static func teamIdentifier(inCodesignOutput output: String) -> String? {
        for line in output.split(separator: "\n") {
            guard line.hasPrefix("TeamIdentifier=") else { continue }
            let value = line.dropFirst("TeamIdentifier=".count)
                .trimmingCharacters(in: .whitespaces)
            // codesign prints this literal for unsigned or ad-hoc signed code.
            return value == "not set" || value.isEmpty ? nil : value
        }
        return nil
    }
}
