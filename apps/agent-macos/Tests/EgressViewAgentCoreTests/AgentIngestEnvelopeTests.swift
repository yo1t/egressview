import Foundation
import XCTest
@testable import EgressViewAgentCore

final class AgentIngestEnvelopeTests: XCTestCase {
    func testDecodesSharedGoldenPayload() throws {
        let data = try Data(contentsOf: goldenFixtureURL())
        let envelope = try decoder().decode(AgentIngestEnvelope.self, from: data)

        XCTAssertEqual(envelope.schemaVersion, AgentIngestEnvelope.currentSchemaVersion)
        XCTAssertEqual(envelope.agent.hostName, "macbook-air")
        XCTAssertEqual(envelope.agent.platform, .macOS)
        XCTAssertEqual(envelope.observations.count, 1)
        XCTAssertEqual(envelope.observations[0].networkProtocol, .tcp)
        XCTAssertEqual(envelope.observations[0].bytesIn, "9007199254740993")
        XCTAssertNil(envelope.observations[0].bytesOut)
    }

    func testMapsObservationWithoutAddingProhibitedContext() throws {
        let observation = ConnectionObservation(
            networkProtocol: .udp,
            localAddress: "2001:db8::10",
            localPort: 50_000,
            remoteAddress: "2606:4700:4700::1111",
            remotePort: 443,
            processID: 42,
            processName: "Browser",
            bundleID: "com.example.browser",
            firstObservedAt: Date(timeIntervalSince1970: 100),
            lastObservedAt: Date(timeIntervalSince1970: 101),
            bytesIn: UInt64.max,
            bytesOut: 12,
            collector: .networkExtension,
            confidence: .exact
        )
        let mapped = AgentIngestObservation(
            observationId: UUID(uuidString: "00000000-0000-4000-8000-000000000001")!,
            observation: observation
        )
        let envelope = AgentIngestEnvelope(
            batchId: UUID(uuidString: "00000000-0000-4000-8000-000000000002")!,
            sentAt: Date(timeIntervalSince1970: 102),
            agent: AgentIngestMetadata(
                hostName: "test-mac",
                platform: .macOS,
                osVersion: "26.5.2",
                agentVersion: "0.1.13"
            ),
            observations: [mapped]
        )

        let data = try encoder().encode(envelope)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let rows = try XCTUnwrap(json["observations"] as? [[String: Any]])
        let row = try XCTUnwrap(rows.first)

        XCTAssertEqual(row["bytesIn"] as? String, String(UInt64.max))
        XCTAssertEqual(row["bytesOut"] as? String, "12")
        XCTAssertNil(row["commandLine"])
        XCTAssertNil(row["userName"])
        XCTAssertNil(row["filePath"])
        XCTAssertNil(row["payload"])
    }

    private func goldenFixtureURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("protocol/agent-ingest/v1/golden.json")
    }

    private func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
