import XCTest
@testable import EgressViewAgentCore

/// Where a country comes from when the daily cache does not have the address
/// (P3-115).
final class GeoLookupSourceTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() {
        super.setUp()
        suite = "geo-lookup-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suite)
        super.tearDown()
    }

    func test既定はHubに聞く_外へは出さない() {
        // The Hub has usually resolved the address already, and asking it
        // sends nothing out of the network it is on.
        let preferences = GeoCachePreferences(defaults: defaults)
        XCTAssertEqual(preferences.lookupSource, .hub)
        XCTAssertFalse(preferences.lookupSource.usesThirdParty)
    }

    func test古い設定を引き継ぐ() {
        // Someone who had turned third-party lookups on keeps them on, rather
        // than having the setting quietly revert under them.
        let preferences = GeoCachePreferences(defaults: defaults)
        preferences.thirdPartyLookupEnabled = true
        XCTAssertEqual(preferences.lookupSource, .hubThenThirdParty)
    }

    func test選び直すと古い鍵も揃う() {
        let preferences = GeoCachePreferences(defaults: defaults)
        preferences.lookupSource = .hubThenThirdParty
        XCTAssertTrue(preferences.thirdPartyLookupEnabled)
        preferences.lookupSource = .cacheOnly
        XCTAssertFalse(preferences.thirdPartyLookupEnabled)
    }

    func test取得しないを選んだら聞きに行かない() {
        let preferences = GeoCachePreferences(defaults: defaults)
        preferences.lookupSource = .cacheOnly
        XCTAssertFalse(preferences.shouldFetchOnDemand(
            now: Date(), hasHub: true, hasUnknownAddresses: true
        ))
    }

    func test知らないアドレスが無ければ聞かない() {
        let preferences = GeoCachePreferences(defaults: defaults)
        XCTAssertFalse(preferences.shouldFetchOnDemand(
            now: Date(), hasHub: true, hasUnknownAddresses: false
        ))
    }

    func testHubが無ければ聞けない() {
        let preferences = GeoCachePreferences(defaults: defaults)
        XCTAssertFalse(preferences.shouldFetchOnDemand(
            now: Date(), hasHub: false, hasUnknownAddresses: true
        ))
    }

    func test短い間隔で何度も聞かない() {
        // A page that opens fifty new destinations must ask once, not fifty
        // times: the Hub answers the whole cache, not one address.
        let preferences = GeoCachePreferences(defaults: defaults)
        let now = Date()
        XCTAssertTrue(preferences.shouldFetchOnDemand(
            now: now, hasHub: true, hasUnknownAddresses: true
        ))
        preferences.lastOnDemandAt = now
        XCTAssertFalse(preferences.shouldFetchOnDemand(
            now: now.addingTimeInterval(5), hasHub: true, hasUnknownAddresses: true
        ))
        XCTAssertTrue(preferences.shouldFetchOnDemand(
            now: now.addingTimeInterval(GeoCachePreferences.onDemandInterval + 1),
            hasHub: true, hasUnknownAddresses: true
        ))
    }

    func test一日一回の取得はそのまま残る() {
        // On-demand is an addition, not a replacement.
        XCTAssertEqual(GeoCachePreferences.fetchInterval, 24 * 60 * 60)
        XCTAssertLessThan(GeoCachePreferences.onDemandInterval, GeoCachePreferences.fetchInterval)
    }
}

/// The third-party lookup, which until 2026-09-13 existed only as a toggle
/// wired to nothing.
final class ThirdPartyGeoLookupTests: XCTestCase {
    private struct StubTransport: ThirdPartyGeoLookup.Transport {
        let body: Data
        let status: Int
        let seen: @Sendable (URLRequest) -> Void

        func post(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            seen(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            return (body, response)
        }
    }

    private func lookup(
        body: String, status: Int = 200, seen: @escaping @Sendable (URLRequest) -> Void = { _ in }
    ) -> ThirdPartyGeoLookup {
        ThirdPartyGeoLookup(transport: StubTransport(
            body: Data(body.utf8), status: status, seen: seen
        ))
    }

    func test置かれた場所を読み取る() async throws {
        let located = try await lookup(body: """
        [{"status":"success","query":"203.26.188.179","countryCode":"mn","lat":47.9,"lon":106.9,"city":"Ulan Bator"}]
        """).locate(["203.26.188.179"])
        XCTAssertEqual(located.count, 1)
        XCTAssertEqual(located[0].countryCode, "MN", "国コードが大文字に揃っていない")
        XCTAssertEqual(located[0].city, "Ulan Bator")
    }

    func test置けなかったアドレスは捨てる() async throws {
        // A wrong country on the map is worse than a missing one: nothing tells
        // the reader it is wrong.
        let located = try await lookup(body: """
        [{"status":"fail","message":"private range","query":"10.0.0.1"},
         {"status":"success","query":"1.2.3.4","countryCode":"JP","lat":35.0,"lon":139.0,"city":""}]
        """).locate(["10.0.0.1", "1.2.3.4"])
        XCTAssertEqual(located.map(\.ip), ["1.2.3.4"])
        XCTAssertNil(located[0].city, "空の都市名を名前として保存した")
    }

    func test一度に聞く数を抑える() async throws {
        var sentCount = 0
        let addresses = (0..<250).map { "192.0.2.\($0 % 250)" }
        let client = ThirdPartyGeoLookup(transport: StubTransport(
            body: Data("[]".utf8), status: 200,
            seen: { request in
                let sent = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())
                sentCount = (sent as? [String])?.count ?? -1
            }
        ))
        _ = try await client.locate(addresses)
        XCTAssertEqual(sentCount, ThirdPartyGeoLookup.batchSize)
    }

    func test空なら通信しない() async throws {
        var called = false
        let client = ThirdPartyGeoLookup(transport: StubTransport(
            body: Data("[]".utf8), status: 200, seen: { _ in called = true }
        ))
        _ = try await client.locate([])
        XCTAssertFalse(called, "問い合わせるものが無いのに外部へ接続した")
    }

    func test失敗は握りつぶさない() async {
        do {
            _ = try await lookup(body: "", status: 429).locate(["1.2.3.4"])
            XCTFail("429が例外にならなかった")
        } catch {
            XCTAssertEqual(error as? ThirdPartyGeoLookup.Failure, .httpStatus(429))
        }
    }
}
