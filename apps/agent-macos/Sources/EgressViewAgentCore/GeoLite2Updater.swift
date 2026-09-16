import Foundation

/// Fetches the country database using the reader's own MaxMind account.
///
/// The alternative was serving a copy from EgressView's CDN, which would have
/// put the licence's obligations on us: adopt each new build promptly and
/// destroy anything more than thirty days behind it, on behalf of every
/// installation. Letting each person use their own account keeps the agreement
/// between them and MaxMind, where it already is (P3-117).
///
/// **What leaves the Mac here is the credentials, and nothing else.** No
/// watched address is sent, which is the whole reason for having a local table
/// in the first place. The settings screen says so in those words.
public struct GeoLite2Updater: Sendable {
    public static let editionID = "GeoLite2-Country"
    public static let downloadHost = "download.maxmind.com"

    public struct Credentials: Equatable, Sendable {
        public let accountID: String
        public let licenseKey: String

        public init(accountID: String, licenseKey: String) {
            self.accountID = accountID.trimmingCharacters(in: .whitespacesAndNewlines)
            self.licenseKey = licenseKey.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        public var isComplete: Bool { !accountID.isEmpty && !licenseKey.isEmpty }
    }

    public enum Failure: Error, Equatable {
        case missingCredentials
        /// Carries what MaxMind said, because MaxMind says it plainly and the
        /// agent used to throw it away.
        ///
        /// On 2026-09-16 a reader saw only "MaxMind refused that account ID and
        /// licence key" and had no way to tell a mistyped key from an account
        /// without access to this edition. The service distinguishes them in
        /// one short sentence; passing it through costs nothing.
        case unauthorised(String)
        case httpStatus(Int, String)
        case notADatabase(String)
        case archive(String)
    }

    public protocol Transport: Sendable {
        func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    }

    private let transport: any Transport
    private let baseURL: URL

    public init(
        transport: any Transport,
        baseURL: URL = URL(string: "https://\(GeoLite2Updater.downloadHost)/geoip/databases")!
    ) {
        self.transport = transport
        self.baseURL = baseURL
    }

    func request(for credentials: Credentials) -> URLRequest? {
        guard credentials.isComplete else { return nil }
        let url = baseURL
            .appendingPathComponent(Self.editionID)
            .appendingPathComponent("download")
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return nil
        }
        components.queryItems = [URLQueryItem(name: "suffix", value: "tar.gz")]
        guard let final = components.url else { return nil }
        var request = URLRequest(url: final)
        request.httpMethod = "GET"
        // Basic authentication, as MaxMind's own instructions use. The key is
        // never placed in the URL: query strings end up in logs and history.
        let pair = "\(credentials.accountID):\(credentials.licenseKey)"
        let encoded = Data(pair.utf8).base64EncodedString()
        request.setValue("Basic \(encoded)", forHTTPHeaderField: "Authorization")
        return request
    }

    /// What the service said, when it said something a person can read.
    ///
    /// MaxMind answers a refusal with one plain sentence -- "Your account ID or
    /// license key could not be authenticated." for a bad key, something else
    /// for an edition the account cannot reach. An error page or a body of
    /// bytes is not worth showing, so those come back empty and the caller
    /// falls back to its own words.
    static func reason(from data: Data) -> String {
        guard !data.isEmpty, data.count <= 4096,
              let text = String(data: data, encoding: .utf8)
        else { return "" }
        let collapsed = text
            .replacingOccurrences(of: "\n", with: " ")
            .replacingOccurrences(of: "\r", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !collapsed.isEmpty, !collapsed.hasPrefix("<") else { return "" }
        return String(collapsed.prefix(300))
    }

    /// Downloads the current build and returns the `.mmdb` bytes.
    ///
    /// The bytes are parsed before they are returned. A file that does not read
    /// as a MaxMind database never reaches the place a working one is kept:
    /// replacing a good table with a failed download would take away the
    /// answers the agent already had.
    public func fetch(credentials: Credentials) async throws -> (data: Data, metadata: MaxMindDB.Metadata) {
        guard let request = request(for: credentials) else { throw Failure.missingCredentials }
        let (payload, response) = try await transport.get(request)
        switch response.statusCode {
        case 200: break
        case 401, 403: throw Failure.unauthorised(Self.reason(from: payload))
        default: throw Failure.httpStatus(response.statusCode, Self.reason(from: payload))
        }
        let database: Data
        do {
            database = try GzipTar.member(
                endingWith: ".mmdb", inTar: try GzipTar.gunzip(payload)
            )
        } catch {
            throw Failure.archive(String(describing: error))
        }
        do {
            return (database, try MaxMindDB(bytes: database).metadata)
        } catch {
            throw Failure.notADatabase(String(describing: error))
        }
    }

    /// Writes the database where the agent reads it, replacing any previous
    /// copy in one step.
    ///
    /// Atomic on purpose: a half-written file is a database that reads as
    /// corrupt, and the agent would rather keep the old one than briefly have
    /// neither.
    public static func install(_ data: Data, at url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).incoming")
        try data.write(to: temporary, options: .atomic)
        _ = try FileManager.default.replaceItemAt(url, withItemAt: temporary)
    }
}

public struct URLSessionGeoLite2Transport: GeoLite2Updater.Transport {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    /// The permalink answers 302 and the file itself comes from object
    /// storage, so the session follows the redirect. Verified end to end on
    /// 2026-09-16: `download.maxmind.com` redirected to Cloudflare R2 and
    /// returned the 4.3 MB archive.
    public func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GeoLite2Updater.Failure.httpStatus(0, "")
        }
        return (data, http)
    }
}

/// Where the MaxMind account details live: the Keychain, beside the other
/// credentials the agent holds, and never in preferences.
public struct GeoLite2CredentialStore: Sendable {
    public static let accountIDKey = "maxmind-account-id"
    public static let licenseKeyKey = "maxmind-license-key"

    private let keys: any AgentAPIKeyStoring

    public init(keys: any AgentAPIKeyStoring = KeychainAgentAPIKeyStore(
        service: "com.egressview.agent.maxmind"
    )) {
        self.keys = keys
    }

    public func load() throws -> GeoLite2Updater.Credentials? {
        guard let accountID = try keys.load(provider: Self.accountIDKey),
              let licenseKey = try keys.load(provider: Self.licenseKeyKey)
        else { return nil }
        let credentials = GeoLite2Updater.Credentials(
            accountID: accountID, licenseKey: licenseKey
        )
        return credentials.isComplete ? credentials : nil
    }

    public func save(_ credentials: GeoLite2Updater.Credentials) throws {
        try keys.save(credentials.accountID, provider: Self.accountIDKey)
        try keys.save(credentials.licenseKey, provider: Self.licenseKeyKey)
    }

    public func clear() throws {
        try keys.delete(provider: Self.accountIDKey)
        try keys.delete(provider: Self.licenseKeyKey)
    }
}
