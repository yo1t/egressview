import Foundation

/// Asks a third party where an address is, for the addresses nothing else can
/// name.
///
/// **This is the only path that sends a watched destination out of the
/// network**, which is why it runs only when someone has chosen it. The
/// settings screen and the README have said so since before it existed --
/// until 2026-09-13 the toggle was wired to nothing at all, so a reader who
/// turned it on got no lookups and no warning that none were happening
/// (P3-115).
///
/// The service is `ipwho.is`. The first attempt used `ip-api.com`, which the
/// README had named for months: its free tier answers over plain HTTP only,
/// App Transport Security refuses that, and every lookup failed with -1022
/// before it left the Mac. Measured 2026-09-13: `https://ip-api.com/` returns
/// 403 (TLS is a paid feature), `https://ipwho.is/` returns the location.
/// Sending watched addresses in clear text was not a trade worth making for a
/// tool whose purpose is showing what leaves the machine.
public struct ThirdPartyGeoLookup: Sendable {
    /// The free tier has no bulk endpoint -- that is a paid feature -- so this
    /// is one request per address, and the count matters. Free allows 1,000
    /// requests a day; half of that is the most this will spend, so a day of
    /// unusual browsing cannot exhaust the allowance and leave the map blank.
    public static let dailyBudget = 500
    /// Addresses per run. Enough for a burst of new destinations, small enough
    /// that one run cannot spend the day's budget.
    public static let batchSize = 25
    /// One request a second. The published limits are far looser; a monitoring
    /// tool that gets itself rate-limited stops answering the question it
    /// exists to answer.
    public static let minimumInterval: TimeInterval = 1

    public struct Located: Equatable, Sendable {
        public let ip: String
        public let countryCode: String
        public let latitude: Double
        public let longitude: Double
        public let city: String?
    }

    public protocol Transport: Sendable {
        func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    }

    public enum Failure: Error, Equatable {
        case httpStatus(Int)
        case malformedResponse
    }

    private let base: URL
    private let transport: any Transport
    private let sleep: @Sendable (TimeInterval) async -> Void

    public init(
        base: URL = URL(string: "https://ipwho.is")!,
        transport: any Transport,
        sleep: @escaping @Sendable (TimeInterval) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        }
    ) {
        self.base = base
        self.transport = transport
        self.sleep = sleep
    }

    /// The address that is asked about, and nothing else.
    func request(for address: String) -> URLRequest? {
        guard var components = URLComponents(
            url: base.appendingPathComponent(address), resolvingAgainstBaseURL: false
        ) else { return nil }
        components.queryItems = [
            URLQueryItem(name: "fields", value: "success,ip,country_code,latitude,longitude,city"),
        ]
        guard let url = components.url else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        return request
    }

    /// Looks up addresses one at a time and returns only the ones located.
    ///
    /// An address the service cannot place is left out rather than stored as
    /// somewhere: a wrong country on the map is worse than a missing one,
    /// because nothing tells the reader it is wrong.
    ///
    /// A failure ends the run rather than marching through the rest. The free
    /// tier carries no availability guarantee, so the service being down is an
    /// ordinary Tuesday, and the remaining addresses are still in the queue
    /// for the next run.
    public func locate(_ addresses: [String], budget: Int = batchSize) async throws -> [Located] {
        let wanted = Array(addresses.prefix(max(0, min(budget, Self.batchSize))))
        guard !wanted.isEmpty else { return [] }
        var located: [Located] = []
        for (index, address) in wanted.enumerated() {
            guard let request = request(for: address) else { continue }
            if index > 0 { await sleep(Self.minimumInterval) }
            let (data, response) = try await transport.get(request)
            guard response.statusCode == 200 else { throw Failure.httpStatus(response.statusCode) }
            guard let row = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw Failure.malformedResponse
            }
            if let place = Self.located(row, requested: address) { located.append(place) }
        }
        return located
    }

    static func located(_ row: [String: Any], requested: String) -> Located? {
        guard (row["success"] as? Bool) == true,
              let country = row["country_code"] as? String, country.count == 2,
              let latitude = row["latitude"] as? Double,
              let longitude = row["longitude"] as? Double
        else { return nil }
        // The reply echoes the address, but the row is stored against the
        // address that was asked about either way.
        let ip = (row["ip"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? requested
        let city = (row["city"] as? String).flatMap { $0.isEmpty ? nil : $0 }
        return Located(
            ip: ip, countryCode: country.uppercased(),
            latitude: latitude, longitude: longitude, city: city
        )
    }
}

public struct URLSessionThirdPartyGeoTransport: ThirdPartyGeoLookup.Transport {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ThirdPartyGeoLookup.Failure.malformedResponse
        }
        return (data, http)
    }
}
