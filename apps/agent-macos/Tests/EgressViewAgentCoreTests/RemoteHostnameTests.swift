import Foundation
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewNetworkExtension

private func observation(
    remoteHostname: String?,
    at: Date = Date(timeIntervalSince1970: 1_800_000_000)
) -> ConnectionObservation {
    ConnectionObservation(
        networkProtocol: .tcp,
        localAddress: "192.0.2.10",
        localPort: 49_152,
        remoteAddress: "203.0.113.5",
        remotePort: 443,
        processID: 501,
        processName: "Safari",
        bundleID: "com.apple.Safari",
        firstObservedAt: at,
        lastObservedAt: at,
        bytesIn: 10,
        bytesOut: 20,
        collector: .networkExtension,
        confidence: .exact,
        remoteHostname: remoteHostname
    )
}

final class RemoteHostnameIngestBoundaryTests: XCTestCase {
    /// The whole point of stage 1. The shipped Hub's ingest schema is
    /// `.strict()`: an unknown field rejects the entire batch, so every agent
    /// in the field would stop delivering. Sending this needs P3-7's agent-side
    /// negotiation first.
    func testTheHostnameIsNeverPutIntoAnIngestPayload() throws {
        let payload = AgentIngestObservation(
            observationId: UUID(), observation: observation(remoteHostname: "example.com")
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = try XCTUnwrap(String(data: try encoder.encode(payload), encoding: .utf8))

        XCTAssertFalse(json.contains("remoteHostname"), "the strict Hub schema would reject the batch")
        XCTAssertFalse(json.contains("example.com"))
        // The rest of the contract is unchanged.
        XCTAssertTrue(json.contains("\"remoteAddress\":\"203.0.113.5\""))
        XCTAssertTrue(json.contains("\"bytesIn\":\"10\""))
    }

    func testTheHostnameDoesNotChangeFlowIdentity() {
        // Two reports of the same flow, one before the system knew the name.
        XCTAssertEqual(
            observation(remoteHostname: nil).stableKey,
            observation(remoteHostname: "example.com").stableKey
        )
    }

    func testAKnownNameIsNotErasedByALaterFlowWithoutOne() {
        let named = observation(remoteHostname: "example.com")
        let anonymous = observation(remoteHostname: nil)
        XCTAssertEqual(named.merging(anonymous).remoteHostname, "example.com")
        XCTAssertEqual(anonymous.merging(named).remoteHostname, "example.com")
    }
}

final class RemoteHostnameStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-hostname-\(UUID().uuidString)")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    func testTheHostnameIsStoredLocallyAndReadBack() throws {
        let url = directory.appendingPathComponent("history.sqlite")
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([observation(remoteHostname: "cdn.example.com")])
        }
        let reopened = try ObservationStore(fileURL: url)
        let row = try XCTUnwrap(try reopened.observations().first)
        XCTAssertEqual(row.remoteHostname, "cdn.example.com")
        XCTAssertEqual(row.remoteAddress, "203.0.113.5", "the address is still recorded")
    }

    func testAFlowWithNoNameStaysWithoutOne() throws {
        // BSD-socket flows have no name to report. The screen falls back to the
        // address rather than showing a guess.
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        try store.append([observation(remoteHostname: nil)])
        XCTAssertNil(try store.observations().first?.remoteHostname)
    }

    func testAnExistingDatabaseGainsTheColumnWithoutLosingRows() throws {
        // Agents updating from 0.2.1 already have history. The migration must
        // add the column, not start over.
        let url = directory.appendingPathComponent("history.sqlite")
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([observation(remoteHostname: nil)])
            XCTAssertEqual(try store.statistics().rawCount, 1)
        }
        let reopened = try ObservationStore(fileURL: url)
        try reopened.append([observation(remoteHostname: "example.com",
                                         at: Date(timeIntervalSince1970: 1_800_000_100))])
        XCTAssertEqual(try reopened.statistics().rawCount, 2)
        XCTAssertEqual(try reopened.observations().first?.remoteHostname, "example.com")
    }
}

final class RemoteHostnameNormalisationTests: XCTestCase {
    private let adapter = NetworkExtensionFlowAdapter()

    func testAUsableNameIsKept() {
        XCTAssertEqual(adapter.normalizedHostnameForTesting("example.com"), "example.com")
        XCTAssertEqual(adapter.normalizedHostnameForTesting("  example.com  "), "example.com")
    }

    func testUnusableValuesAreDroppedRatherThanStored() {
        // A name nobody can read is not better than the address already shown.
        XCTAssertNil(adapter.normalizedHostnameForTesting(nil))
        XCTAssertNil(adapter.normalizedHostnameForTesting(""))
        XCTAssertNil(adapter.normalizedHostnameForTesting("   "))
        XCTAssertNil(adapter.normalizedHostnameForTesting("host name.example.com"))
        XCTAssertNil(adapter.normalizedHostnameForTesting(String(repeating: "a", count: 254)))
    }
}
