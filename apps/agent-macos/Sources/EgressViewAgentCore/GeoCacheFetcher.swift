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

/// Where a country comes from when the cache does not have the address.
///
/// The cache is fetched from the Hub once a day, so a destination reached for
/// the first time is not in it: measured 2026-09-13, three countries visited
/// at 15:47 were resolved by the Hub within seconds and still absent from the
/// Mac's map, because the next scheduled fetch was eight hours away. The
/// moment worth seeing -- a country reached for the first time -- was the one
/// the map could not show (P3-115).
public enum GeoLookupSource: String, CaseIterable, Sendable {
    /// Only what the last fetch brought. Nothing is asked for.
    case cacheOnly
    /// Ask the Hub again, off-schedule. It has usually resolved the address
    /// already -- it enriches what the agents send it -- and asking it sends
    /// nothing outside the network the Hub is on.
    case hub
    /// The Hub first, then a third party for what the Hub does not know.
    ///
    /// **This is the only path that sends a watched address out of the
    /// network.** It stays off unless someone chooses it.
    case hubThenThirdParty

    public var usesHub: Bool { self != .cacheOnly }
    public var usesThirdParty: Bool { self == .hubThenThirdParty }
}

/// When the agent last fetched locations, and the tag it holds.
public struct GeoCachePreferences: @unchecked Sendable {
    public static let etagKey = "geoCacheETag"
    public static let lastFetchKey = "geoCacheLastFetchedAt"
    public static let thirdPartyLookupKey = "geoThirdPartyLookupEnabled"
    public static let lookupSourceKey = "geoLookupSource"
    public static let lastOnDemandKey = "geoCacheLastOnDemandAt"

    /// The least time between off-schedule fetches.
    ///
    /// The Hub answers the whole cache, not one address, so asking is a few
    /// megabytes when the tag has moved and a 304 when it has not. A minute is
    /// short enough that a country appears while the person is still looking
    /// at the map, and long enough that a burst of new destinations is one
    /// request rather than hundreds.
    public static let onDemandInterval: TimeInterval = 60

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

    /// Where to look when the cache does not have an address.
    ///
    /// Reads the old boolean when no choice has been stored, so someone who
    /// had turned third-party lookups on keeps them on rather than having the
    /// setting silently revert.
    public var lookupSource: GeoLookupSource {
        get {
            if let raw = defaults.string(forKey: Self.lookupSourceKey),
               let source = GeoLookupSource(rawValue: raw) {
                return source
            }
            return thirdPartyLookupEnabled ? .hubThenThirdParty : .hub
        }
        nonmutating set {
            defaults.set(newValue.rawValue, forKey: Self.lookupSourceKey)
            // Kept in step so the older key cannot disagree with the newer one.
            defaults.set(newValue.usesThirdParty, forKey: Self.thirdPartyLookupKey)
        }
    }

    public var lastOnDemandAt: Date? {
        get { defaults.object(forKey: Self.lastOnDemandKey) as? Date }
        nonmutating set { defaults.set(newValue, forKey: Self.lastOnDemandKey) }
    }

    /// May the agent ask the Hub again, outside the daily schedule?
    ///
    /// Asking needs a reason -- an address nobody can name -- and a gap since
    /// the last ask. Without the gap, a page that opens fifty new destinations
    /// would ask fifty times for the same answer.
    public func shouldFetchOnDemand(
        now: Date, hasHub: Bool, hasUnknownAddresses: Bool
    ) -> Bool {
        guard hasHub, hasUnknownAddresses, lookupSource.usesHub else { return false }
        guard let last = lastOnDemandAt, last <= now else { return true }
        return now.timeIntervalSince(last) >= Self.onDemandInterval
    }

    public func shouldFetch(now: Date, hasHub: Bool) -> Bool {
        guard hasHub else { return false }
        guard let last = lastFetchedAt, last <= now else { return true }
        return now.timeIntervalSince(last) >= Self.fetchInterval
    }
}
