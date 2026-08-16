import Foundation
import Security

public enum AgentPackageVerificationError: Error, Equatable {
    case runningBuildIsNotTeamSigned
    case notarisationRejected(String)
    case teamIdentifierMissing
    case teamIdentifierMismatch(expected: String, actual: String)
    case signatureInvalid(OSStatus)
    case packageUnreadable
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

}

/// Checks a downloaded package before it is offered to the user.
///
/// The manifest signature already proves the bytes are the ones we published,
/// so this is a second, independent question: is the package's own signature
/// intact, and was it signed by the same developer as the build currently
/// running?
///
/// **The expected Team ID is read from the running build rather than compiled
/// in.** An update must come from whoever signed what is already installed.
/// That is the property worth enforcing, and it means no signing identity has
/// to be written into the source.
///
/// **This used to shell out to `spctl --assess`, and updates could not be
/// installed at all.** This app is sandboxed, so `spctl` inherits the sandbox
/// and cannot reach `syspolicyd`; every assessment failed with "internal error
/// in Code Signing subsystem". Verified by assessing the same file at the same
/// path from an unsandboxed shell, where it is accepted. Gatekeeper's full
/// assessment -- which is what checks notarisation -- happens when the user
/// opens the disk image, as it would for any download, so asking in advance
/// bought a nicer error message at the cost of the feature working.
public struct AgentPackageVerifier: Sendable {
    /// Returns the Team ID that signed the package, having first checked the
    /// signature is intact. Injected so tests can describe a package without
    /// having to produce a signed one.
    public typealias PackageIdentityResolver = @Sendable (URL) throws -> String?

    private let currentTeamIdentifier: String?
    private let resolveRunningTeamIdentifier: Bool
    private let resolvePackageIdentity: PackageIdentityResolver

    public init() {
        currentTeamIdentifier = nil
        resolveRunningTeamIdentifier = true
        resolvePackageIdentity = { try AgentPackageVerifier.signingTeamIdentifier(ofPackageAt: $0) }
    }

    public init(
        currentTeamIdentifier: String?,
        resolvePackageIdentity: @escaping PackageIdentityResolver
    ) {
        self.currentTeamIdentifier = currentTeamIdentifier
        self.resolveRunningTeamIdentifier = false
        self.resolvePackageIdentity = resolvePackageIdentity
    }

    public func verify(packageAt url: URL) throws {
        // A development build has no Team ID to compare against. Refusing here
        // is deliberate: silently skipping the check would make the weakest
        // build the one with the least protection.
        let expectedTeamIdentifier = resolveRunningTeamIdentifier
            ? AgentCodeIdentity.currentTeamIdentifier()
            : currentTeamIdentifier
        guard let expected = expectedTeamIdentifier, !expected.isEmpty else {
            throw AgentPackageVerificationError.runningBuildIsNotTeamSigned
        }

        // In-process, so nothing has to cross the sandbox. This checks the
        // package's signature is intact and unmodified; it does not check
        // notarisation, which needs `syspolicyd` and is done by macOS when the
        // image is opened.
        let actual = try resolvePackageIdentity(url)
        guard let actual else { throw AgentPackageVerificationError.teamIdentifierMissing }
        guard actual == expected else {
            throw AgentPackageVerificationError.teamIdentifierMismatch(expected: expected, actual: actual)
        }
    }

    /// Validates the signature and returns the Team ID that made it.
    ///
    /// `SecStaticCodeCheckValidity` is the same check `codesign --verify`
    /// performs, run in this process rather than in a child that would inherit
    /// the sandbox.
    public static func signingTeamIdentifier(ofPackageAt url: URL) throws -> String? {
        var staticCode: SecStaticCode?
        let created = SecStaticCodeCreateWithPath(url as CFURL, SecCSFlags(), &staticCode)
        guard created == errSecSuccess, let staticCode else {
            throw AgentPackageVerificationError.packageUnreadable
        }

        let valid = SecStaticCodeCheckValidity(staticCode, SecCSFlags(), nil)
        guard valid == errSecSuccess else {
            throw AgentPackageVerificationError.signatureInvalid(valid)
        }

        var information: CFDictionary?
        let flags = SecCSFlags(rawValue: kSecCSSigningInformation)
        guard SecCodeCopySigningInformation(staticCode, flags, &information) == errSecSuccess,
              let details = information as? [String: Any] else {
            throw AgentPackageVerificationError.teamIdentifierMissing
        }
        let team = details[kSecCodeInfoTeamIdentifier as String] as? String
        return (team?.isEmpty ?? true) ? nil : team
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
