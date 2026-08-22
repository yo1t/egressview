import Foundation

public enum ThreatIntelFetchError: Error, Equatable {
    case insecureURL
    case httpStatus(Int)
    case malformedPayload
    case unsupportedSchemaVersion(Int)
    case transport(String)
}

public enum ThreatIntelFetchResult: Equatable, Sendable {
    /// The set changed and these are the current indicators.
    case updated(indicators: [ThreatIndicator], etag: String?, fetchedAt: Date?)
    /// Nothing has changed since the stored tag.
    case unchanged
    /// The Hub runs without feeds. Distinct from an empty set: nobody looked,
    /// so the screen must not report that nothing was found.
    case hubHasNoFeeds
}

/// Fetches threat indicators from the Hub the agent is enrolled with.
///
/// The request carries no destinations. Asking "is this address dangerous?" by
/// sending the address tells the other end exactly what the user was worried
/// about, which is the thing this design exists to avoid. The whole indicator
/// set comes back -- about ten thousand entries, six times smaller than the
/// location cache already handled this way -- and the matching happens locally.
public struct ThreatIntelFetcher: Sendable {
    public static let supportedSchemaVersions = [1]

    private let hubURL: URL
    private let token: String
    private let userAgent: String
    private let transport: any GeoCacheTransport

    public init(
        hubURL: URL,
        token: String,
        userAgent: String,
        transport: any GeoCacheTransport = URLSessionGeoCacheTransport()
    ) {
        self.hubURL = hubURL
        self.token = token
        self.userAgent = userAgent
        self.transport = transport
    }

    public func fetch(knownETag: String?) async throws -> ThreatIntelFetchResult {
        let url = hubURL.appendingPathComponent("api/agent/threat-intel")
        guard url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            throw ThreatIntelFetchError.insecureURL
        }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("gzip", forHTTPHeaderField: "Accept-Encoding")
        if let knownETag {
            request.setValue(knownETag, forHTTPHeaderField: "If-None-Match")
        }
        request.httpShouldHandleCookies = false

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.fetch(request)
        } catch let error as ThreatIntelFetchError {
            throw error
        } catch {
            throw ThreatIntelFetchError.transport(error.localizedDescription)
        }

        if response.statusCode == 304 { return .unchanged }
        guard response.statusCode == 200 else {
            throw ThreatIntelFetchError.httpStatus(response.statusCode)
        }
        return try Self.decode(data, etag: response.value(forHTTPHeaderField: "ETag"))
    }

    /// Indicators arrive positionally: `[value, source, tag]` under `ips`,
    /// `domains` and `cidrs`.
    ///
    /// A malformed entry is skipped rather than failing the whole fetch. One bad
    /// row should not cost the user every indicator the Hub holds.
    static func decode(_ data: Data, etag: String?) throws -> ThreatIntelFetchResult {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let schemaVersion = root["schemaVersion"] as? Int
        else {
            throw ThreatIntelFetchError.malformedPayload
        }
        guard supportedSchemaVersions.contains(schemaVersion) else {
            throw ThreatIntelFetchError.unsupportedSchemaVersion(schemaVersion)
        }
        if let available = root["available"] as? Bool, available == false {
            return .hubHasNoFeeds
        }

        func indicators(_ key: String, _ kind: ThreatIndicator.Kind) -> [ThreatIndicator] {
            guard let rows = root[key] as? [[Any]] else { return [] }
            return rows.compactMap { row in
                guard let value = row.first as? String, !value.isEmpty else { return nil }
                return ThreatIndicator(
                    kind: kind,
                    value: value,
                    source: row.count > 1 ? row[1] as? String : nil,
                    tag: row.count > 2 ? row[2] as? String : nil
                )
            }
        }

        var fetchedAt: Date?
        if let text = root["fetchedAt"] as? String {
            fetchedAt = ISO8601DateFormatter().date(from: text)
        }

        return .updated(
            indicators: indicators("ips", .ip)
                + indicators("domains", .domain)
                + indicators("cidrs", .cidr),
            etag: etag,
            fetchedAt: fetchedAt
        )
    }
}

/// Whether the agent may download threat feeds itself, and when it last did.
///
/// Off by default and only meaningful without a Hub. A Hub-enrolled agent takes
/// indicators from its Hub and this setting is not offered, because having both
/// would mean contacting third parties for something already available -- and
/// the promise that nothing leaves the Mac would quietly stop being true.
public struct ThreatIntelPreferences: @unchecked Sendable {
    public static let etagKey = "threatIntelETag"
    public static let lastFetchKey = "threatIntelLastFetch"
    public static let directDownloadKey = "threatIntelDirectDownloadEnabled"
    public static let hubFallbackKey = "threatIntelHubFallbackEnabled"

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public var etag: String? {
        get { defaults.string(forKey: Self.etagKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.etagKey) }
    }

    public var lastFetch: Date? {
        get {
            let seconds = defaults.double(forKey: Self.lastFetchKey)
            return seconds > 0 ? Date(timeIntervalSince1970: seconds) : nil
        }
        nonmutating set {
            defaults.set(newValue?.timeIntervalSince1970 ?? 0, forKey: Self.lastFetchKey)
        }
    }

    /// Standalone only. Downloading the public feeds sends no destinations
    /// anywhere -- they are plain lists, not lookup services -- but it does
    /// reveal to their operators that this Mac is asking, so it stays a
    /// decision the user makes rather than one made for them.
    public var isDirectDownloadEnabled: Bool {
        get { defaults.bool(forKey: Self.directDownloadKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.directDownloadKey) }
    }

    /// Explicit permission to contact public feed operators when an enrolled
    /// Hub is unavailable and the cached indicators are at least one day old.
    public var isHubFallbackEnabled: Bool {
        get { defaults.bool(forKey: Self.hubFallbackKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.hubFallbackKey) }
    }
}
