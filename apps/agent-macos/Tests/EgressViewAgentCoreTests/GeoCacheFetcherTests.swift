import Foundation
import XCTest
@testable import EgressViewAgentCore

private struct StubTransport: GeoCacheTransport {
    var payload: Data = Data()
    var status: Int = 200
    var etag: String? = "W/\"geo-1-abc\""
    var failure: (any Error)?
    /// Captured so the test can assert what the request did and did not carry.
    final class Capture: @unchecked Sendable { var request: URLRequest? }
    let capture = Capture()

    func fetch(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        capture.request = request
        if let failure { throw failure }
        var headers: [String: String] = [:]
        if let etag { headers["ETag"] = etag }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers
        )!
        return (payload, response)
    }
}

private func payload(_ entries: String, schemaVersion: Int = 1) -> Data {
    Data("""
    {"schemaVersion": \(schemaVersion), "generatedAt": "2026-08-15T00:00:00Z", "entries": [\(entries)]}
    """.utf8)
}

final class GeoCacheFetcherTests: XCTestCase {
    private let hub = URL(string: "https://hub.example.com")!

    private func fetcher(_ transport: StubTransport) -> GeoCacheFetcher {
        GeoCacheFetcher(
            hubURL: hub, token: "secret", userAgent: "EgressViewAgent/0.3.0", transport: transport
        )
    }

    func testTheRequestCarriesNoDestinations() async throws {
        // The whole point. A request that named the addresses would tell the Hub
        // what this agent is looking at, which is what a user who turned
        // delivery off chose not to send.
        let transport = StubTransport(payload: payload(#"["203.0.113.5", 35.6, 139.7, "JP", "Tokyo"]"#))
        _ = try await fetcher(transport).fetch(knownETag: nil)

        let request = try XCTUnwrap(transport.capture.request)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertNil(request.httpBody)
        XCTAssertEqual(request.url?.path, "/api/agent/geo-cache")
        XCTAssertNil(request.url?.query, "no addresses in the query either")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer secret")
    }

    func testLocationsAreDecodedFromThePositionalForm() async throws {
        let transport = StubTransport(payload: payload(
            #"["203.0.113.5", 35.6, 139.7, "JP", "Tokyo"], ["198.51.100.2", 37.4, -122.1, "US", "Mountain View"]"#
        ))
        guard case let .updated(entries, etag) = try await fetcher(transport).fetch(knownETag: nil) else {
            return XCTFail("expected locations")
        }
        XCTAssertEqual(entries.count, 2)
        XCTAssertEqual(entries.first?.ip, "203.0.113.5")
        XCTAssertEqual(entries.first?.city, "Tokyo")
        XCTAssertEqual(entries.last?.countryCode, "US")
        XCTAssertEqual(etag, "W/\"geo-1-abc\"")
    }

    func testAKnownTagIsSentAndAnUnchangedReplyCostsNothing() async throws {
        let transport = StubTransport(payload: Data(), status: 304)
        let result = try await fetcher(transport).fetch(knownETag: "W/\"geo-1-abc\"")
        XCTAssertEqual(result, .unchanged)
        XCTAssertEqual(
            transport.capture.request?.value(forHTTPHeaderField: "If-None-Match"),
            "W/\"geo-1-abc\""
        )
    }

    func testOneBadRowDoesNotCostTheUserEveryOtherLocation() async throws {
        let transport = StubTransport(payload: payload(
            #"["203.0.113.5", 35.6, 139.7, "JP", "Tokyo"], ["broken"], ["", 1, 2], ["198.51.100.2", 999, 0]"#
        ))
        guard case let .updated(entries, _) = try await fetcher(transport).fetch(knownETag: nil) else {
            return XCTFail("expected locations")
        }
        XCTAssertEqual(entries.map(\.ip), ["203.0.113.5"], "impossible coordinates are skipped too")
    }

    func testAnUnknownSchemaVersionIsRefusedRatherThanGuessedAt() async {
        let transport = StubTransport(payload: payload("", schemaVersion: 2))
        do {
            _ = try await fetcher(transport).fetch(knownETag: nil)
            XCTFail("expected a refusal")
        } catch let error as GeoCacheFetchError {
            XCTAssertEqual(error, .unsupportedSchemaVersion(2))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testAnErrorStatusIsSurfacedRatherThanTreatedAsEmpty() async {
        // Treating a failure as "no locations" would blank the map and blame it
        // on the data.
        let transport = StubTransport(payload: Data(), status: 503)
        do {
            _ = try await fetcher(transport).fetch(knownETag: nil)
            XCTFail("expected a failure")
        } catch let error as GeoCacheFetchError {
            XCTAssertEqual(error, .httpStatus(503))
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }

    func testAPlaintextHubIsRefusedUnlessItIsLoopback() async {
        let insecure = GeoCacheFetcher(
            hubURL: URL(string: "http://hub.example.com")!, token: "t", userAgent: "a",
            transport: StubTransport()
        )
        do {
            _ = try await insecure.fetch(knownETag: nil)
            XCTFail("expected a refusal")
        } catch let error as GeoCacheFetchError {
            XCTAssertEqual(error, .insecureURL)
        } catch {
            XCTFail("unexpected error: \(error)")
        }
    }
}

final class GeoCachePreferencesTests: XCTestCase {
    private func makePreferences() throws -> (GeoCachePreferences, UserDefaults, String) {
        let suite = "com.egressview.agent.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        return (GeoCachePreferences(defaults: defaults), defaults, suite)
    }

    func testThirdPartyLookupIsOffUntilTheUserTurnsItOn() throws {
        // A tool that watches outbound traffic must not quietly send the very
        // destinations it is watching to someone else.
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(preferences.thirdPartyLookupEnabled)
    }

    func testAnAgentWithNoHubNeverFetches() throws {
        // Standalone. There is nobody to ask, and asking anyone else is the
        // thing that is off by default.
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(preferences.shouldFetch(now: Date(), hasHub: false))
    }

    func testFetchingHappensAtMostOncePerDay() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        XCTAssertTrue(preferences.shouldFetch(now: now, hasHub: true), "never fetched yet")
        preferences.lastFetchedAt = now
        XCTAssertFalse(preferences.shouldFetch(now: now.addingTimeInterval(23 * 3_600), hasHub: true))
        XCTAssertTrue(preferences.shouldFetch(now: now.addingTimeInterval(25 * 3_600), hasHub: true))
    }

    func testABackwardsClockDoesNotSuppressFetching() throws {
        let (preferences, defaults, suite) = try makePreferences()
        defer { defaults.removePersistentDomain(forName: suite) }
        let now = Date()
        preferences.lastFetchedAt = now.addingTimeInterval(30 * 86_400)
        XCTAssertTrue(preferences.shouldFetch(now: now, hasHub: true))
    }
}
