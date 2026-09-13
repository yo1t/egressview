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

    func test一日に使う件数に上限がある() {
        // The free tier is 1,000 requests a day and one request is one
        // address. Discovering the limit as a wall of failures is not a plan.
        let preferences = GeoCachePreferences(defaults: defaults)
        let day = GeoCachePreferences.day(for: Date())
        XCTAssertEqual(
            preferences.thirdPartyBudget(on: day, limit: 500, perRun: 25), 25,
            "使い始めから一度分が取れない"
        )
        preferences.recordThirdPartySpend(490, on: day)
        XCTAssertEqual(
            preferences.thirdPartyBudget(on: day, limit: 500, perRun: 25), 10,
            "残りを超えて使おうとしている"
        )
        preferences.recordThirdPartySpend(10, on: day)
        XCTAssertEqual(preferences.thirdPartyBudget(on: day, limit: 500, perRun: 25), 0)
    }

    func test日が変われば使える() {
        let preferences = GeoCachePreferences(defaults: defaults)
        preferences.recordThirdPartySpend(500, on: "2026-09-13")
        XCTAssertEqual(preferences.thirdPartySpent(on: "2026-09-14"), 0)
        XCTAssertEqual(preferences.thirdPartyBudget(on: "2026-09-14", limit: 500, perRun: 25), 25)
    }

    func test上限は無料枠の半分に収まっている() {
        // 1,000 a day is the published free allowance; spending all of it on a
        // busy day would leave the map blank on the next one.
        XCTAssertLessThanOrEqual(ThirdPartyGeoLookup.dailyBudget, 500)
        XCTAssertLessThanOrEqual(ThirdPartyGeoLookup.batchSize, ThirdPartyGeoLookup.dailyBudget)
    }
}

/// The third-party lookup, which until 2026-09-13 existed only as a toggle/// wired to nothing.
///
/// It asks `ipwho.is`, over HTTPS. The first attempt asked `ip-api.com`,
/// whose free tier is plain HTTP: App Transport Security refused every
/// request, and the settings screen greeted 0.5.68's first user with a raw
/// NSError before they had touched anything.
final class ThirdPartyGeoLookupTests: XCTestCase {
    private struct StubTransport: ThirdPartyGeoLookup.Transport {
        let bodies: [Data]
        let status: Int
        let seen: @Sendable (URLRequest) -> Void
        let index: Counter

        final class Counter: @unchecked Sendable {
            private let lock = NSLock()
            private var value = 0
            var count: Int { lock.withLock { value } }
            func next() -> Int { lock.withLock { defer { value += 1 }; return value } }
        }

        func get(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
            seen(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil
            )!
            let position = index.next()
            return (bodies[min(position, bodies.count - 1)], response)
        }
    }

    private func lookup(
        bodies: [String], status: Int = 200,
        seen: @escaping @Sendable (URLRequest) -> Void = { _ in }
    ) -> ThirdPartyGeoLookup {
        ThirdPartyGeoLookup(
            transport: StubTransport(
                bodies: bodies.map { Data($0.utf8) }, status: status, seen: seen,
                index: StubTransport.Counter()
            ),
            // The real one waits a second between addresses; a test must not.
            sleep: { _ in }
        )
    }

    func test置かれた場所を読み取る() async throws {
        let located = try await lookup(bodies: ["""
        {"success":true,"ip":"203.26.188.179","country_code":"mn","latitude":47.9,"longitude":106.9,"city":"Ulan Bator"}
        """]).locate(["203.26.188.179"])
        XCTAssertEqual(located.count, 1)
        XCTAssertEqual(located[0].countryCode, "MN", "国コードが大文字に揃っていない")
        XCTAssertEqual(located[0].city, "Ulan Bator")
    }

    func test暗号化されない経路では聞かない() async throws {
        // The whole reason the provider changed. Plain HTTP would put the
        // addresses this Mac talks to on the wire in clear text, and macOS
        // refuses it anyway.
        var scheme: String?
        _ = try await lookup(
            bodies: ["{\"success\":false}"], seen: { scheme = $0.url?.scheme }
        ).locate(["1.2.3.4"])
        XCTAssertEqual(scheme, "https")
    }

    func test聞くのは宛先アドレスだけ() async throws {
        var url: URL?
        _ = try await lookup(
            bodies: ["{\"success\":false}"], seen: { url = $0.url }
        ).locate(["203.0.113.9"])
        XCTAssertEqual(url?.host, "ipwho.is")
        XCTAssertEqual(url?.path, "/203.0.113.9")
        XCTAssertEqual(
            url?.query, "fields=success,ip,country_code,latitude,longitude,city",
            "求める項目以外を送っている"
        )
    }

    func test置けなかったアドレスは捨てる() async throws {
        // A wrong country on the map is worse than a missing one: nothing tells
        // the reader it is wrong.
        let located = try await lookup(bodies: [
            "{\"success\":false,\"message\":\"Reserved range\"}",
            "{\"success\":true,\"ip\":\"1.2.3.4\",\"country_code\":\"JP\",\"latitude\":35.0,\"longitude\":139.0,\"city\":\"\"}",
        ]).locate(["10.0.0.1", "1.2.3.4"])
        XCTAssertEqual(located.map(\.ip), ["1.2.3.4"])
        XCTAssertNil(located[0].city, "空の都市名を名前として保存した")
    }

    func test一度に聞く数を抑える() async throws {
        // No bulk endpoint on the free tier: one request is one address, so
        // the count of requests is the count of addresses.
        let counter = StubTransport.Counter()
        let client = ThirdPartyGeoLookup(
            transport: StubTransport(
                bodies: [Data("{\"success\":false}".utf8)], status: 200, seen: { _ in },
                index: counter
            ),
            sleep: { _ in }
        )
        _ = try await client.locate((0..<250).map { "192.0.2.\($0 % 250)" })
        XCTAssertEqual(counter.count, ThirdPartyGeoLookup.batchSize)
    }

    func test渡された予算を超えない() async throws {
        let counter = StubTransport.Counter()
        let client = ThirdPartyGeoLookup(
            transport: StubTransport(
                bodies: [Data("{\"success\":false}".utf8)], status: 200, seen: { _ in },
                index: counter
            ),
            sleep: { _ in }
        )
        _ = try await client.locate((0..<20).map { "192.0.2.\($0)" }, budget: 3)
        XCTAssertEqual(counter.count, 3, "その日の残りを超えて問い合わせた")
    }

    func test空なら通信しない() async throws {
        var called = false
        let client = ThirdPartyGeoLookup(
            transport: StubTransport(
                bodies: [Data("{}".utf8)], status: 200, seen: { _ in called = true },
                index: StubTransport.Counter()
            ),
            sleep: { _ in }
        )
        _ = try await client.locate([])
        XCTAssertFalse(called, "問い合わせるものが無いのに外部へ接続した")
    }

    func test失敗したらその場でやめる() async {
        // The free tier has no uptime guarantee. Marching through the rest of
        // the queue against a service that is down is how a rate limit turns
        // into a ban.
        let counter = StubTransport.Counter()
        let client = ThirdPartyGeoLookup(
            transport: StubTransport(
                bodies: [Data().self], status: 429, seen: { _ in }, index: counter
            ),
            sleep: { _ in }
        )
        do {
            _ = try await client.locate(["1.2.3.4", "5.6.7.8", "9.10.11.12"])
            XCTFail("429が例外にならなかった")
        } catch {
            XCTAssertEqual(error as? ThirdPartyGeoLookup.Failure, .httpStatus(429))
            XCTAssertEqual(counter.count, 1, "失敗した後も問い合わせ続けた")
        }
    }
}
