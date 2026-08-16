import XCTest
@testable import EgressViewAgentCore

final class ConnectionLogFilterTests: XCTestCase {
    private func observation(
        processName: String = "Safari",
        networkProtocol: InternetProtocol = .tcp,
        remotePort: UInt16 = 443,
        bytesIn: UInt64? = 100,
        bytesOut: UInt64? = 50,
        collector: CollectorKind = .networkExtension
    ) -> ConnectionObservation {
        ConnectionObservation(
            networkProtocol: networkProtocol,
            localAddress: "192.0.2.5",
            localPort: 51234,
            remoteAddress: "198.51.100.10",
            remotePort: remotePort,
            processID: 501,
            processName: processName,
            bundleID: nil,
            firstObservedAt: Date(timeIntervalSince1970: 1_700_000_000),
            lastObservedAt: Date(timeIntervalSince1970: 1_700_000_060),
            bytesIn: bytesIn,
            bytesOut: bytesOut,
            collector: collector,
            confidence: .exact,
            remoteHostname: "example.com"
        )
    }

    private func matches(
        _ filter: ConnectionLogFilter,
        _ observation: ConnectionObservation,
        destinationText: String = "example.com",
        countryCode: String? = "JP"
    ) -> Bool {
        filter.matches(observation, destinationText: destinationText, countryCode: countryCode)
    }

    func test_既定では何も絞り込まない() {
        let filter = ConnectionLogFilter()
        XCTAssertFalse(filter.isActive)
        XCTAssertTrue(matches(filter, observation()))
    }

    func test_アプリ名は大文字小文字を区別せず部分一致() {
        var filter = ConnectionLogFilter()
        filter.application = "saf"
        XCTAssertTrue(matches(filter, observation()))
        filter.application = "mail"
        XCTAssertFalse(matches(filter, observation()))
    }

    /// The filter must match the text on screen, not the stored address:
    /// typing a hostname should not fail because the row is kept by address.
    func test_通信先は画面に出ている文字列に一致させる() {
        var filter = ConnectionLogFilter()
        filter.destination = "example"
        XCTAssertTrue(matches(filter, observation(), destinationText: "example.com"))
        XCTAssertFalse(matches(filter, observation(), destinationText: "198.51.100.10"))
    }

    func test_国コードで絞り込む() {
        var filter = ConnectionLogFilter()
        filter.country = "JP"
        XCTAssertTrue(matches(filter, observation(), countryCode: "JP"))
        XCTAssertFalse(matches(filter, observation(), countryCode: "US"))
        XCTAssertFalse(matches(filter, observation(), countryCode: nil))
    }

    /// "Unknown" is a real answer people look for, not the absence of a filter.
    func test_国が不明な行だけを選べる() {
        var filter = ConnectionLogFilter()
        filter.isUnplacedCountryOnly = true
        XCTAssertTrue(matches(filter, observation(), countryCode: nil))
        XCTAssertFalse(matches(filter, observation(), countryCode: "JP"))
    }

    func test_プロトコルで絞り込む() {
        var filter = ConnectionLogFilter()
        filter.networkProtocol = .udp
        XCTAssertFalse(matches(filter, observation(networkProtocol: .tcp)))
        XCTAssertTrue(matches(filter, observation(networkProtocol: .udp)))
    }

    /// Prefix, not substring: typing 4 should offer 443 and 4430, not 8443.
    func test_ポートは前方一致() {
        var filter = ConnectionLogFilter()
        filter.port = "44"
        XCTAssertTrue(matches(filter, observation(remotePort: 443)))
        XCTAssertFalse(matches(filter, observation(remotePort: 8443)))
    }

    func test_計測済みと未計測を選び分けられる() {
        var filter = ConnectionLogFilter()
        filter.volume = .measured
        XCTAssertTrue(matches(filter, observation(bytesIn: 10, bytesOut: nil)))
        XCTAssertFalse(matches(filter, observation(bytesIn: nil, bytesOut: nil)))

        filter.volume = .unmeasured
        XCTAssertFalse(matches(filter, observation(bytesIn: 10, bytesOut: nil)))
        XCTAssertTrue(matches(filter, observation(bytesIn: nil, bytesOut: nil)))
    }

    func test_収集元で絞り込む() {
        var filter = ConnectionLogFilter()
        filter.collector = .libproc
        XCTAssertFalse(matches(filter, observation(collector: .networkExtension)))
        XCTAssertTrue(matches(filter, observation(collector: .libproc)))
    }

    func test_条件は重ねてすべて満たす必要がある() {
        var filter = ConnectionLogFilter()
        filter.application = "Safari"
        filter.networkProtocol = .udp
        XCTAssertFalse(matches(filter, observation(processName: "Safari", networkProtocol: .tcp)))
        XCTAssertTrue(matches(filter, observation(processName: "Safari", networkProtocol: .udp)))
    }

    func test_何か指定すれば絞り込み中と分かる() {
        var filter = ConnectionLogFilter()
        filter.port = "443"
        XCTAssertTrue(filter.isActive)
    }
}
