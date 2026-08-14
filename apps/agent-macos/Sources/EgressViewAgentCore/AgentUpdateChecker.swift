import Foundation

public protocol AgentUpdateTransport: Sendable {
    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionAgentUpdateTransport: AgentUpdateTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 20) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AgentUpdateError.transport("not an HTTP response")
        }
        return (data, response)
    }
}

/// Asks the distribution host whether a newer agent exists.
///
/// What is sent is the whole story of this feature: a GET, a User-Agent naming
/// the product, its version and the OS version, and nothing else. There is no
/// agent ID, no install ID, and no cookie -- the session is ephemeral with
/// cookies disabled. Two runs on the same Mac are indistinguishable from two
/// runs on different Macs holding the same version.
///
/// The agent watches its own outbound traffic, so the user will see this
/// request in their own logs. It has to be something we can explain.
public struct AgentUpdateChecker: Sendable {
    public static let defaultOrigin = URL(string: "https://dl.egressview.com")!

    private let origin: URL
    private let platform: String
    private let arch: String
    private let currentVersion: String
    private let osVersion: String
    private let transport: any AgentUpdateTransport

    public init(
        origin: URL = AgentUpdateChecker.defaultOrigin,
        platform: String = "macos",
        arch: String = AgentUpdateChecker.hostArch,
        currentVersion: String,
        osVersion: String,
        transport: any AgentUpdateTransport = URLSessionAgentUpdateTransport()
    ) {
        self.origin = origin
        self.platform = platform
        self.arch = arch
        self.currentVersion = currentVersion
        self.osVersion = osVersion
        self.transport = transport
    }

    public static var hostArch: String {
        #if arch(arm64)
        return "arm64"
        #else
        return "x64"
        #endif
    }

    /// Deliberately explicit. A version that only reaches the log because some
    /// framework happened to append it is not something we can describe
    /// honestly in the README.
    public var userAgent: String {
        "EgressViewAgent/\(currentVersion) (macOS \(osVersion))"
    }

    public func check() async throws -> AgentUpdateDecision {
        // A build whose embedded key is not the published one must not install
        // anything. Failing here rather than at signature verification names
        // the real problem.
        guard AgentReleaseKey.matchesPublishedFingerprint else {
            throw AgentUpdateError.embeddedKeyNotPublished
        }

        let manifestData = try await get(path: "\(platform)/manifest.json")
        let signature = try await get(path: "\(platform)/manifest.json.sig")

        // Verify before parsing. Unsigned bytes should never reach a decoder.
        guard AgentReleaseKey.isValidSignature(signature, for: manifestData) else {
            throw AgentUpdateError.signatureInvalid
        }

        guard let manifest = try? JSONDecoder().decode(AgentUpdateManifest.self, from: manifestData) else {
            throw AgentUpdateError.malformedManifest
        }
        guard AgentUpdateManifest.supportedSchemaVersions.contains(manifest.schemaVersion) else {
            throw AgentUpdateError.unsupportedSchemaVersion(manifest.schemaVersion)
        }
        guard manifest.platform == platform else {
            throw AgentUpdateError.platformMismatch(manifest.platform)
        }
        guard
            let published = AgentSemanticVersion(manifest.version),
            let installed = AgentSemanticVersion(currentVersion)
        else {
            throw AgentUpdateError.malformedManifest
        }

        // Refuse to move backwards. A rolled-back manifest, or one served from
        // a stale cache, must never walk an agent down to an older build.
        guard published > installed else { return .upToDate }

        guard let package = manifest.package(forArch: arch) else {
            throw AgentUpdateError.noPackageForArch(arch)
        }
        guard package.url.scheme == "https" else { throw AgentUpdateError.insecureURL }

        return .updateAvailable(version: manifest.version, package: package)
    }

    private func get(path: String) async throws -> Data {
        let url = origin.appendingPathComponent(path)
        guard url.scheme == "https" else { throw AgentUpdateError.insecureURL }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false

        let (data, response): (Data, HTTPURLResponse)
        do {
            (data, response) = try await transport.fetch(request)
        } catch let error as AgentUpdateError {
            throw error
        } catch {
            throw AgentUpdateError.transport(error.localizedDescription)
        }
        guard response.statusCode == 200 else {
            throw AgentUpdateError.httpStatus(response.statusCode)
        }
        return data
    }
}
