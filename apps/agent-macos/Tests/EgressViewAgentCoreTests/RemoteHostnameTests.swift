import Foundation
import SQLite3
import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewNetworkExtension

private func observation(
    remoteHostname: String?,
    at: Date = Date(timeIntervalSince1970: 1_800_000_000),
    flowID: UUID? = nil,
    bytesIn: UInt64? = 10,
    bytesOut: UInt64? = 20
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
        bytesIn: bytesIn,
        bytesOut: bytesOut,
        collector: .networkExtension,
        confidence: .exact,
        remoteHostname: remoteHostname,
        flowID: flowID
    )
}

final class RemoteHostnameIngestBoundaryTests: XCTestCase {
    /// The whole point of stage 1. The shipped Hub's ingest schema is
    /// `.strict()`: an unknown field rejects the entire batch, so every agent
    /// in the field would stop delivering. Sending this needs P3-7's agent-side
    /// negotiation first.
    func testTheHostnameIsNeverPutIntoAnIngestPayload() throws {
        let payload = AgentIngestObservation(
            observationId: UUID(),
            observation: observation(remoteHostname: "example.com", flowID: UUID())
        )
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let json = try XCTUnwrap(String(data: try encoder.encode(payload), encoding: .utf8))

        XCTAssertFalse(json.contains("remoteHostname"), "the strict Hub schema would reject the batch")
        XCTAssertFalse(json.contains("flowID"), "the local flow identity must never cross the Hub boundary")
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

    func testClosingReportEnrichesTheOpeningRowInsteadOfDuplicatingTheFlow() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        let flowID = UUID()
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([observation(
            remoteHostname: nil, at: started, flowID: flowID,
            bytesIn: nil, bytesOut: nil
        )])
        try store.append([observation(
            remoteHostname: "api.example.com", at: started.addingTimeInterval(30),
            flowID: flowID, bytesIn: 1_200, bytesOut: 340
        )])

        XCTAssertEqual(try store.statistics().rawCount, 1)
        let row = try XCTUnwrap(try store.observations().first)
        XCTAssertEqual(row.flowID, flowID)
        XCTAssertEqual(row.remoteHostname, "api.example.com")
        XCTAssertEqual(row.bytesIn, 1_200)
        XCTAssertEqual(row.bytesOut, 340)
        XCTAssertEqual(row.firstObservedAt, started)
        XCTAssertEqual(row.lastObservedAt, started.addingTimeInterval(30))
    }

    func testFlowUpdateDoesNotDoubleCountAllTimeCountryHistory() throws {
        let store = try ObservationStore(fileURL: directory.appendingPathComponent("h.sqlite"))
        try store.replaceGeoLocations([
            GeoLocation(
                ip: "203.0.113.5", latitude: 35, longitude: 139,
                countryCode: "JP", city: "Tokyo"
            ),
        ])
        let flowID = UUID()
        let started = Date(timeIntervalSince1970: 1_800_000_000)
        try store.append([observation(
            remoteHostname: "api.example.com", at: started,
            flowID: flowID, bytesIn: nil, bytesOut: nil
        )])
        try store.append([observation(
            remoteHostname: "api.example.com", at: started.addingTimeInterval(30),
            flowID: flowID, bytesIn: 1_200, bytesOut: 340
        )])
        try store.flushCountryVisitSummary()

        XCTAssertEqual(try store.countryVisitSummaries().first?.connectionCount, 1)
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

    func testVersionNineDatabaseGainsFlowIdentityWithoutLosingHistory() throws {
        let url = directory.appendingPathComponent("history.sqlite")
        do {
            let store = try ObservationStore(fileURL: url)
            try store.append([observation(remoteHostname: "existing.example")])
        }

        var database: OpaquePointer?
        XCTAssertEqual(sqlite3_open(url.path, &database), SQLITE_OK)
        defer {
            if let database { sqlite3_close(database) }
        }
        let downgrade = """
        DROP INDEX observations_flow_id;
        ALTER TABLE observations DROP COLUMN flow_id;
        PRAGMA user_version=9;
        """
        var errorMessage: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, downgrade, nil, nil, &errorMessage)
        let message = errorMessage.map { String(cString: $0) } ?? ""
        sqlite3_free(errorMessage)
        XCTAssertEqual(result, SQLITE_OK, message)
        sqlite3_close(database)
        database = nil

        let reopened = try ObservationStore(fileURL: url)
        XCTAssertEqual(try reopened.statistics().rawCount, 1)
        XCTAssertEqual(try reopened.observations().first?.remoteHostname, "existing.example")
        let flowID = UUID()
        try reopened.append([observation(
            remoteHostname: "new.example",
            at: Date(timeIntervalSince1970: 1_800_000_100),
            flowID: flowID
        )])
        XCTAssertEqual(try reopened.observations().first?.flowID, flowID)
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
