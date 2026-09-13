import XCTest
@testable import EgressViewAgentCore

/// What the Agent is allowed to ask a third party about.
///
/// The Hub has refused private, loopback, link-local and multicast addresses
/// since it first had a geo lookup. The Agent's own lookup shipped without that
/// check, and the result was not subtle: measured on one Mac 2026-09-13, minutes
/// after install, 400 of the day's 500 requests were gone and the queue was
/// headed by that machine's own router and subnet, six link-local `fe80::`
/// addresses and a multicast `ff02::` address.
final class NonPublicAddressTests: XCTestCase {
    func test_ローカルなアドレスは公開先ではない() {
        for address in [
            "10.0.0.1", "10.255.255.254", "192.168.0.1", "172.16.0.1", "172.31.255.254",
            "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
            "224.0.0.251", "255.255.255.255",
            "192.0.2.1", "198.51.100.7", "203.0.113.9",   // documentation
            "fe80::1", "ff02::1:2", "fc00::1", "fd12:3456::1", "::1", "::",
            "2001:db8::1",
            "fe80::aede:48ff:fe00:1122%en0",              // scoped literal
            "::ffff:192.168.1.1",                         // IPv4-mapped
        ] {
            XCTAssertTrue(
                NonPublicAddress.isNonPublic(address),
                "\(address) must never be sent to a location service"
            )
        }
    }

    /// The other half, and the one that matters for the map: a public address
    /// must still be asked about. A filter that is too eager silently costs a
    /// destination its country, which looks the same on screen as a lookup that
    /// was never made.
    func test_公開アドレスは通す() {
        for address in [
            "8.8.8.8", "1.1.1.1", "2001:700:100:118::130", "2606:4700::1111",
            "172.15.0.1", "172.32.0.1",   // just outside 172.16.0.0/12
            "100.63.255.255", "100.128.0.1", // just outside 100.64.0.0/10
            "11.0.0.1", "126.255.255.255", "128.0.0.1",
            "169.253.0.1", "169.255.0.1",
            "192.167.255.255", "192.169.0.1",
            "2001:4860:4860::8888",
        ] {
            XCTAssertFalse(
                NonPublicAddress.isNonPublic(address),
                "\(address) is public and must still be looked up"
            )
        }
    }

    /// A hostname is a name someone chose; this has nothing to say about it.
    func test_アドレスでないものは判定しない() {
        for value in ["example.com", "", "not-an-address", "10.0.0", "10.0.0.256"] {
            XCTAssertFalse(NonPublicAddress.isNonPublic(value))
        }
    }
}

/// The queue that feeds the lookup.
final class PendingCountryQueueTests: XCTestCase {
    private var store: ObservationStore!
    private var url: URL!
    private let now = Date(timeIntervalSince1970: 1_757_000_000)

    override func setUpWithError() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("pending-\(UUID().uuidString).sqlite")
        store = try ObservationStore(fileURL: url)
    }

    override func tearDownWithError() throws {
        store = nil
        try? FileManager.default.removeItem(at: url)
    }

    private func observe(_ address: String, at date: Date? = nil) throws {
        try store.append([ConnectionObservation(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: address, remotePort: 443, processID: 1,
            processName: "curl", bundleID: nil,
            firstObservedAt: date ?? now, lastObservedAt: date ?? now,
            bytesIn: 10, bytesOut: 20, collector: .networkExtension,
            confidence: .exact, remoteHostname: nil
        )])
        try store.flushCountryVisitSummary()
    }

    func test_ローカルなアドレスは待ち行列に入らない() throws {
        try observe("10.0.0.1")
        try observe("192.168.0.1")
        try observe("fe80::1")
        try observe("ff02::1:2")
        try observe("8.8.8.8")

        XCTAssertEqual(try store.pendingCountryAddresses(now: now), ["8.8.8.8"])
    }

    /// The queue is read newest-first, so an address that cannot be placed sits
    /// at the head of it. Without a record of the failed attempt the same
    /// addresses are re-sent on every run, which is how a 500-request day was
    /// spent without placing anything.
    func test_引けなかったアドレスは一定期間送り直さない() throws {
        try observe("8.8.8.8")
        XCTAssertEqual(try store.pendingCountryAddresses(now: now), ["8.8.8.8"])

        try store.recordCountryLookupFailures(["8.8.8.8"], now: now)
        XCTAssertEqual(
            try store.pendingCountryAddresses(now: now.addingTimeInterval(3600)), [],
            "an address just asked about must not be asked again on the next run"
        )

        let afterInterval = now.addingTimeInterval(ObservationStore.pendingCountryRetryInterval + 1)
        XCTAssertEqual(
            try store.pendingCountryAddresses(now: afterInterval), ["8.8.8.8"],
            "a service that was down, or a range since registered, is tried again"
        )
    }

    /// An install from before the filter still holds the rows it queued, and is
    /// still spending its budget on them. The migration is what stops that, and
    /// it has to be exact: a pattern wide enough to catch 172.16.0.0/12 also
    /// catches the public 172.1.0.0/16.
    /// 172.1.0.9 is the case that rules out a pattern match: it is public, and
    /// any `LIKE '172.1%'` wide enough to catch 172.16.0.0/12 deletes it too.
    /// Losing it here means a real destination silently has no country.
    func test_公開アドレスは似た並びでも残る() throws {
        try observe("172.1.0.9")
        try observe("172.16.0.9")
        try observe("100.63.255.255")
        try observe("100.64.0.1")

        XCTAssertEqual(
            Set(try store.pendingCountryAddresses(now: now)), ["172.1.0.9", "100.63.255.255"]
        )
    }
}
