import Foundation

/// Semantic version, compared numerically so that `0.10.0` sorts above `0.9.0`.
/// String comparison would get that backwards and offer a downgrade as an
/// update.
public struct AgentSemanticVersion: Comparable, Equatable, Sendable, CustomStringConvertible {
    public let major: Int
    public let minor: Int
    public let patch: Int
    private let prerelease: String?

    public init?(_ text: String) {
        let core = text.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
        let numbers = core[0].split(separator: ".", omittingEmptySubsequences: false)
        guard numbers.count == 3 else { return nil }
        guard let major = Int(numbers[0]), let minor = Int(numbers[1]), let patch = Int(numbers[2]) else {
            return nil
        }
        guard major >= 0, minor >= 0, patch >= 0 else { return nil }
        self.major = major
        self.minor = minor
        self.patch = patch
        prerelease = core.count > 1 && !core[1].isEmpty ? String(core[1]) : nil
    }

    public var description: String {
        let core = "\(major).\(minor).\(patch)"
        return prerelease.map { "\(core)-\($0)" } ?? core
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        if lhs.major != rhs.major { return lhs.major < rhs.major }
        if lhs.minor != rhs.minor { return lhs.minor < rhs.minor }
        if lhs.patch != rhs.patch { return lhs.patch < rhs.patch }
        // A prerelease precedes its own release, per semver.
        switch (lhs.prerelease, rhs.prerelease) {
        case (nil, nil): return false
        case (nil, _): return false
        case (_, nil): return true
        case let (left?, right?): return left < right
        }
    }
}

/// One downloadable package. The manifest carries a list of these rather than a
/// single URL, because macOS ships one architecture today but Windows will need
/// two, and agents already in the field must not have to relearn the shape.
public struct AgentUpdatePackage: Decodable, Equatable, Sendable {
    public let arch: String
    public let packageType: String
    public let url: URL
    public let sha256: String
    public let sizeBytes: Int
}

/// Unknown fields are ignored rather than rejected -- the same must-ignore rule
/// the ingest contract uses. A newer publisher adding a field must not stop
/// existing agents from seeing updates, which is the exact situation automatic
/// updating exists to prevent.
public struct AgentUpdateManifest: Decodable, Equatable, Sendable {
    public let schemaVersion: Int
    public let platform: String
    public let version: String
    public let packages: [AgentUpdatePackage]

    public static let supportedSchemaVersions = [1]

    public func package(forArch arch: String) -> AgentUpdatePackage? {
        packages.first { $0.arch == arch }
    }
}

public enum AgentUpdateDecision: Equatable, Sendable {
    /// The installed version is current, or newer than what is published.
    case upToDate
    case updateAvailable(version: String, package: AgentUpdatePackage)
}

public enum AgentUpdateError: Error, Equatable {
    case embeddedKeyNotPublished
    case transport(String)
    case httpStatus(Int)
    case malformedManifest
    case signatureInvalid
    case unsupportedSchemaVersion(Int)
    case platformMismatch(String)
    case noPackageForArch(String)
    case insecureURL
}

/// Whether a package left on disk is still worth offering.
///
/// An agent can be updated by other means -- a manual install, or a colleague
/// with a disk image -- while a verified download from before is still stored.
/// Offering it then walks the user backwards. The version check refuses to move
/// backwards when it runs, but nothing re-examined what had already been
/// stored, so the menu offered a downgrade until the next check happened.
public enum AgentStoredUpdate {
    public static func isStillAnUpgrade(
        storedVersion: String, runningVersion: String
    ) -> Bool {
        guard let stored = AgentSemanticVersion(storedVersion),
              let running = AgentSemanticVersion(runningVersion) else {
            // Unparseable either way: discard rather than offer something that
            // cannot be shown to be newer.
            return false
        }
        return stored > running
    }
}
