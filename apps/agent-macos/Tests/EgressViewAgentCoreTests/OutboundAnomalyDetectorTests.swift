import Foundation
import XCTest
@testable import EgressViewAgentCore

final class OutboundAnomalyDetectorTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testDoesNotDecideBeforeOneDayOfBaseline() {
        let detector = OutboundAnomalyDetector()
        let baseline = (0..<95).map { window(index: $0, bytes: 10 * 1_024 * 1_024) }

        XCTAssertNil(detector.evaluate(
            current: window(index: 96, bytes: 500 * 1_024 * 1_024), baseline: baseline
        ))
    }

    func testDetectsLargeOutboundChangeAgainstStableBaseline() throws {
        let detector = OutboundAnomalyDetector()
        let baseline = (0..<96).map { window(index: $0, bytes: 20 * 1_024 * 1_024) }

        let finding = try XCTUnwrap(detector.evaluate(
            current: window(index: 96, bytes: 200 * 1_024 * 1_024), baseline: baseline
        ))

        XCTAssertEqual(finding.kind, .largeTransfer)
        XCTAssertEqual(finding.baselineMedianBytesOut, 20 * 1_024 * 1_024)
        XCTAssertEqual(finding.alertThresholdBytesOut, 100 * 1_024 * 1_024)
    }

    func testClassifiesTrafficSpreadAcrossApplicationsAndDestinations() throws {
        let detector = OutboundAnomalyDetector()
        let baseline = (0..<96).map { window(index: $0, bytes: 20 * 1_024 * 1_024) }
        let current = window(
            index: 96, bytes: 300 * 1_024 * 1_024,
            applications: 5, destinations: 30, largestAppBytes: 120 * 1_024 * 1_024
        )

        XCTAssertEqual(
            try XCTUnwrap(detector.evaluate(current: current, baseline: baseline)).kind,
            .distributedTransfer
        )
    }

    func testIncompleteByteDataNeverAlertsOrTrainsBaseline() {
        var configuration = OutboundAnomalyDetector.Configuration()
        configuration.minimumBaselineWindows = 2
        let detector = OutboundAnomalyDetector(configuration: configuration)
        let poor = window(index: 0, bytes: 1, observationsWithBytes: 5)
        let good = window(index: 1, bytes: 1)

        XCTAssertNil(detector.evaluate(
            current: window(index: 2, bytes: 500 * 1_024 * 1_024),
            baseline: [poor, good]
        ))
        XCTAssertNil(detector.evaluate(
            current: window(index: 2, bytes: 500 * 1_024 * 1_024, observationsWithBytes: 5),
            baseline: [good, good]
        ))
    }

    func testMedianAndMadResistOneLargeBaselineWindow() {
        var configuration = OutboundAnomalyDetector.Configuration()
        configuration.minimumBaselineWindows = 5
        let detector = OutboundAnomalyDetector(configuration: configuration)
        let baseline = [10, 10, 11, 12, 900].enumerated().map {
            window(index: $0.offset, bytes: UInt64($0.element) * 1_024 * 1_024)
        }

        XCTAssertNotNil(detector.evaluate(
            current: window(index: 5, bytes: 150 * 1_024 * 1_024), baseline: baseline
        ))
    }

    private func window(
        index: Int, bytes: UInt64, observationsWithBytes: Int = 100,
        applications: Int = 2, destinations: Int = 5, largestAppBytes: UInt64? = nil
    ) -> OutboundTrafficWindow {
        OutboundTrafficWindow(
            startedAt: start.addingTimeInterval(Double(index * 900)),
            bytesOut: bytes,
            observationCount: 100,
            observationsWithBytes: observationsWithBytes,
            applicationCount: applications,
            destinationCount: destinations,
            largestApplicationBytesOut: largestAppBytes ?? bytes
        )
    }
}
