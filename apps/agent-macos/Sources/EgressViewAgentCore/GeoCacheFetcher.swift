import Foundation

public enum GeoCacheFetchError: Error, Equatable {
    case insecureURL
    case httpStatus(Int)
    case malformedPayload
    case unsupportedSchemaVersion(Int)
    case transport(String)
}

public enum GeoCacheFetchResult: Equatable, Sendable {
    /// The Hub's cache changed and these are the current locations.
    case updated(entries: [GeoLocation], etag: String?)
    /// The Hub replied that nothing has changed since the stored tag.
    case unchanged
}

public protocol GeoCacheTransport: Sendable {
    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionGeoCacheTransport: GeoCacheTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 120) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw GeoCacheFetchError.transport("not an HTTP response")
        }
        return (data, response)
    }
}

/// Fetches destination locations from the Hub the agent is enrolled with.
///
/// The request carries no destinations. The whole cache comes back and the
/// matching happens locally, so the Hub never learns which addresses this agent
/// is interested in -- which for someone who has turned delivery off is exactly
/// what they chose not to send.
public struct GeoCacheFetcher: Sendable {
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

    public func fetch(knownETag: String?) async throws -> GeoCacheFetchResult {
        let url = hubURL.appendingPathComponent("api/agent/geo-cache")
        guard url.scheme == "https" || url.host == "localhost" || url.host == "127.0.0.1" else {
            throw GeoCacheFetchError.insecureURL
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
        } catch let error as GeoCacheFetchError {
            throw error
        } catch {
            throw GeoCacheFetchError.transport(error.localizedDescription)
        }

        if response.statusCode == 304 { return .unchanged }
        guard response.statusCode == 200 else {
            throw GeoCacheFetchError.httpStatus(response.statusCode)
        }
        return .updated(
            entries: try Self.decode(data),
            etag: response.value(forHTTPHeaderField: "ETag")
        )
    }

    /// Entries arrive positionally: `[ip, lat, lon, countryCode, city]`.
    ///
    /// A malformed entry is skipped rather than failing the whole fetch. One bad
    /// row should not cost the user every location the Hub knows.
    static func decode(_ data: Data) throws -> [GeoLocation] {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GeoCacheFetchError.malformedPayload
        }
        guard let schemaVersion = root["schemaVersion"] as? Int else {
            throw GeoCacheFetchError.malformedPayload
        }
        guard supportedSchemaVersions.contains(schemaVersion) else {
            throw GeoCacheFetchError.unsupportedSchemaVersion(schemaVersion)
        }
        guard let entries = root["entries"] as? [[Any]] else {
            throw GeoCacheFetchError.malformedPayload
        }

        return entries.compactMap { entry in
            guard entry.count >= 3,
                  let ip = entry[0] as? String, !ip.isEmpty,
                  let latitude = (entry[1] as? NSNumber)?.doubleValue,
                  let longitude = (entry[2] as? NSNumber)?.doubleValue,
                  latitude >= -90, latitude <= 90,
                  longitude >= -180, longitude <= 180
            else {
                return nil
            }
            return GeoLocation(
                ip: ip,
                latitude: latitude,
                longitude: longitude,
                countryCode: entry.count > 3 ? entry[3] as? String : nil,
                city: entry.count > 4 ? entry[4] as? String : nil
            )
        }
    }
}

/// When the agent last fetched locations, and the tag it holds.
public struct GeoCachePreferences: @unchecked Sendable {
    public static let etagKey = "geoCacheETag"
    public static let lastFetchKey = "geoCacheLastFetchedAt"
    public static let thirdPartyLookupKey = "geoThirdPartyLookupEnabled"

    /// Same cadence as the update check: the Hub's cache moves by a handful of
    /// rows a day.
    public static let fetchInterval: TimeInterval = 24 * 60 * 60

    private let defaults: UserDefaults

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // Looking addresses up with a third party is off unless the user turns
        // it on. A tool that watches outbound traffic must not quietly send the
        // very destinations it is watching to someone else.
        defaults.register(defaults: [Self.thirdPartyLookupKey: false])
    }

    public var etag: String? {
        get { defaults.string(forKey: Self.etagKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.etagKey) }
    }

    public var lastFetchedAt: Date? {
        get { defaults.object(forKey: Self.lastFetchKey) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Self.lastFetchKey) }
    }

    public var thirdPartyLookupEnabled: Bool {
        get { defaults.bool(forKey: Self.thirdPartyLookupKey) }
        nonmutating set { defaults.set(newValue, forKey: Self.thirdPartyLookupKey) }
    }

    public func shouldFetch(now: Date, hasHub: Bool) -> Bool {
        guard hasHub else { return false }
        guard let last = lastFetchedAt, last <= now else { return true }
        return now.timeIntervalSince(last) >= Self.fetchInterval
    }
}
