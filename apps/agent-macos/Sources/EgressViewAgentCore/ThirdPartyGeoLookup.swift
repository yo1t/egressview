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
public struct ThirdPartyGeoLookup: Sendable {
    /// The free tier allows 45 requests a minute and answers 100 addresses per
    /// request. Asking for 100 at a time keeps a day's worth of new
    /// destinations inside a single request.
    public static let batchSize = 100
    /// Left well under the published limit. A monitoring tool that gets itself
    /// rate-limited stops answering the question it exists to answer.
    public static let minimumInterval: TimeInterval = 2

    public struct Located: Equatable, Sendable {
        public let ip: String
        public let countryCode: String
        public let latitude: Double
        public let longitude: Double
        public let city: String?
    }

    public protocol Transport: Sendable {
        func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
    }

    public enum Failure: Error, Equatable {
        case httpStatus(Int)
        case malformedResponse
    }

    private let endpoint: URL
    private let transport: any Transport

    public init(
        endpoint: URL = URL(string: "http://ip-api.com/batch?fields=status,message,countryCode,lat,lon,city,query")!,
        transport: any Transport
    ) {
        self.endpoint = endpoint
        self.transport = transport
    }

    /// Looks up one batch and returns only the addresses that were located.
    ///
    /// An address the service cannot place is left out rather than stored as
    /// somewhere: a wrong country on the map is worse than a missing one,
    /// because nothing tells the reader it is wrong.
    public func locate(_ addresses: [String]) async throws -> [Located] {
        let batch = Array(addresses.prefix(Self.batchSize))
        guard !batch.isEmpty else { return [] }
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: batch)
        let (data, response) = try await transport.post(request)
        guard response.statusCode == 200 else { throw Failure.httpStatus(response.statusCode) }
        guard let rows = try JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
            throw Failure.malformedResponse
        }
        return rows.compactMap(Self.located)
    }

    static func located(_ row: [String: Any]) -> Located? {
        guard (row["status"] as? String) == "success",
              let ip = row["query"] as? String,
              let country = row["countryCode"] as? String, country.count == 2,
              let latitude = row["lat"] as? Double,
              let longitude = row["lon"] as? Double
        else { return nil }
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

    public func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw ThirdPartyGeoLookup.Failure.malformedResponse
        }
        return (data, http)
    }
}
