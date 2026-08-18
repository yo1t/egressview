import XCTest
@testable import EgressViewAgentCore
@testable import EgressViewNetworkExtension

final class TLSClientHelloTests: XCTestCase {
    /// Builds a ClientHello around a server_name extension, so the tests
    /// exercise the same offsets a real client produces rather than a fixture
    /// nobody can check.
    private func clientHello(
        serverName: String?,
        sessionIDLength: Int = 32,
        extraExtensionsBefore: Int = 0,
        truncateBy: Int = 0
    ) -> Data {
        var extensions = Data()
        for i in 0..<extraExtensionsBefore {
            extensions += be16(UInt16(0x1000 + i))   // some other extension
            extensions += be16(2)
            extensions += Data([0xAA, 0xBB])
        }
        if let serverName {
            let host = Data(serverName.utf8)
            var list = Data([0x00])                  // name type: host_name
            list += be16(UInt16(host.count))
            list += host
            var body = be16(UInt16(list.count))
            body += list
            extensions += be16(0x0000)               // server_name
            extensions += be16(UInt16(body.count))
            extensions += body
        }

        var hello = Data()
        hello += be16(0x0303)                        // client version
        hello += Data(repeating: 0x5A, count: 32)    // random
        hello += Data([UInt8(sessionIDLength)])
        hello += Data(repeating: 0x11, count: sessionIDLength)
        hello += be16(2); hello += Data([0x13, 0x01])  // cipher suites
        hello += Data([1, 0])                          // compression methods
        hello += be16(UInt16(extensions.count))
        hello += extensions

        var handshake = Data([0x01])
        handshake += Data([0, UInt8(hello.count >> 8), UInt8(hello.count & 0xFF)])
        handshake += hello

        var record = Data([0x16])
        record += be16(0x0301)
        record += be16(UInt16(handshake.count))
        record += handshake
        return truncateBy > 0 ? record.prefix(record.count - truncateBy) : record
    }

    private func be16(_ value: UInt16) -> Data {
        Data([UInt8(value >> 8), UInt8(value & 0xFF)])
    }

    func test_ClientHelloからサーバ名を取り出す() {
        XCTAssertEqual(
            TLSClientHello.serverName(in: clientHello(serverName: "example.com")),
            "example.com"
        )
    }

    func test_他の拡張が前にあっても見つける() {
        XCTAssertEqual(
            TLSClientHello.serverName(
                in: clientHello(serverName: "shop.example.co.uk", extraExtensionsBefore: 5)
            ),
            "shop.example.co.uk"
        )
    }

    func test_大文字は小文字に揃える() {
        XCTAssertEqual(
            TLSClientHello.serverName(in: clientHello(serverName: "EXAMPLE.COM")),
            "example.com"
        )
    }

    func test_セッションIDが無くても読める() {
        XCTAssertEqual(
            TLSClientHello.serverName(in: clientHello(serverName: "a.example", sessionIDLength: 0)),
            "a.example"
        )
    }

    func test_server_name拡張が無ければnil() {
        XCTAssertNil(TLSClientHello.serverName(in: clientHello(serverName: nil)))
    }

    /// Everything below is attacker-controlled. A malformed message must yield
    /// nothing rather than a guess: a wrong name is a false statement about
    /// where traffic went, which is worse than no name at all.
    func test_途中で切れていてもnilを返し落ちない() {
        let full = clientHello(serverName: "example.com")
        for cut in 1..<full.count {
            _ = TLSClientHello.serverName(in: full.prefix(full.count - cut))
        }
        XCTAssertNil(TLSClientHello.serverName(in: full.prefix(20)))
    }

    func test_ハンドシェイクでないレコードはnil() {
        var record = clientHello(serverName: "example.com")
        record[record.startIndex] = 0x17            // application data
        XCTAssertNil(TLSClientHello.serverName(in: record))
    }

    func test_ClientHelloでないハンドシェイクはnil() {
        var record = clientHello(serverName: "example.com")
        record[record.startIndex + 5] = 0x02        // ServerHello
        XCTAssertNil(TLSClientHello.serverName(in: record))
    }

    func test_空データはnil() {
        XCTAssertNil(TLSClientHello.serverName(in: Data()))
    }

    func test_無関係なバイト列はnil() {
        XCTAssertNil(TLSClientHello.serverName(in: Data(repeating: 0x16, count: 512)))
    }

    /// A name that came off the wire is not automatically a name.
    func test_名前として不自然なものは受け付けない() {
        XCTAssertFalse(TLSClientHello.isPlausibleHostname(""))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname("nodot"))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname(".leading.dot"))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname("trailing.dot."))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname("has space.example"))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname("semi;colon.example"))
        XCTAssertFalse(TLSClientHello.isPlausibleHostname(String(repeating: "a", count: 300) + ".example"))
        XCTAssertTrue(TLSClientHello.isPlausibleHostname("a-b.example.com"))
    }

    func test_おかしな名前を含むClientHelloはnil() {
        XCTAssertNil(TLSClientHello.serverName(in: clientHello(serverName: "no dots here")))
    }
}

final class ServerNamePolicyTests: XCTestCase {
    /// The default has to be off. An agent that starts reading handshakes
    /// because it was updated would have broken a promise nobody re-made.
    func test_既定では読み取らない() {
        let policy = PassOnlyFlowPolicy()
        XCTAssertFalse(policy.readsServerName)
        XCTAssertEqual(policy.decision, .allowAndReportMetadata)
    }

    func test_有効にすると最初の送信データだけを見る判定になる() {
        let policy = PassOnlyFlowPolicy(readsServerName: true)
        XCTAssertEqual(policy.decision, .allowAndReadServerName)
    }

    /// Still false when enabled. The opening bytes of a handshake are not the
    /// payload: they are sent in the clear, before there is a key, and nothing
    /// past them is read.
    func test_有効にしてもペイロードを読むことにはならない() {
        XCTAssertFalse(PassOnlyFlowPolicy(readsServerName: true).readsPayload)
        XCTAssertFalse(PassOnlyFlowPolicy(readsServerName: false).readsPayload)
    }

    func test_設定は既定でOFF() throws {
        let suite = "server-name-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let preferences = ServerNamePreferences(defaults: defaults)
        XCTAssertFalse(preferences.isEnabled)
        preferences.isEnabled = true
        XCTAssertTrue(ServerNamePreferences(defaults: defaults).isEnabled)
    }
}

final class ServerNameRegistryTests: XCTestCase {
    private let flowID = UUID()

    private func metadata(hostname: String?) -> SocketFlowMetadata {
        SocketFlowMetadata(
            networkProtocol: .tcp, localAddress: "192.0.2.5", localPort: 1,
            remoteAddress: "203.0.113.7", remotePort: 443,
            processID: 1, processName: "curl", bundleID: nil, remoteHostname: hostname
        )
    }

    private func complete(_ registry: inout OpenFlowRegistry) -> ConnectionObservation? {
        registry.complete(
            flowID: flowID, kind: .flowClosed, bytesIn: 1, bytesOut: 2,
            metadata: nil, reportedAt: Date()
        )
    }

    func test_名前の無いフローに読み取った名前を入れる() {
        var registry = OpenFlowRegistry()
        registry.register(flowID: flowID, metadata: metadata(hostname: nil), startedAt: Date())
        registry.noteServerName("read.example", flowID: flowID)
        XCTAssertEqual(complete(&registry)?.remoteHostname, "read.example")
    }

    /// macOS supplies the name for flows that went through its own networking,
    /// and that one is authoritative. This only fills gaps.
    func test_macOSが教えてくれた名前を上書きしない() {
        var registry = OpenFlowRegistry()
        registry.register(flowID: flowID, metadata: metadata(hostname: "from.macos"), startedAt: Date())
        registry.noteServerName("read.example", flowID: flowID)
        XCTAssertEqual(complete(&registry)?.remoteHostname, "from.macos")
    }

    func test_知らないフローの名前は捨てる() {
        var registry = OpenFlowRegistry()
        registry.noteServerName("read.example", flowID: flowID)
        XCTAssertNil(complete(&registry))
    }
}
