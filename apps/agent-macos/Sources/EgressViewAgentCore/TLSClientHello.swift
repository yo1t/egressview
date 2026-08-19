import Foundation

/// Reads the server name out of a TLS ClientHello.
///
/// This is the only thing the agent ever looks at inside a connection, and it
/// looks at it only when the user has turned that on. The name is in the
/// clear because the client has to say where it is going before it can agree
/// on a key -- nothing here decrypts anything.
///
/// Every length in the message is attacker-controlled, so every read is bounds
/// checked and a malformed message yields nil rather than a guess. Returning
/// the wrong name would be worse than returning none: the whole point is to
/// label a destination, and a mislabelled destination is a false statement
/// about where traffic went.
public enum TLSClientHello {
    /// The most a ClientHello is worth reading. Real ones are a few hundred
    /// bytes; the record layer allows 16 KiB, and a client that needs more than
    /// this to say its own name is not one we can help.
    public static let maximumInterestingBytes = 4096

    public static func serverName(in data: Data) -> String? {
        var outer = Reader(data)

        // Record header: handshake (0x16), version, length.
        guard outer.byte() == 0x16 else { return nil }
        guard outer.skip(2) else { return nil }
        guard let recordLength = outer.uint16(), recordLength > 0,
              let record = outer.take(Int(recordLength))
        else { return nil }
        var recordReader = Reader(record)

        // Handshake header: ClientHello (0x01) and a 24-bit length.
        guard recordReader.byte() == 0x01,
              let handshakeLength = recordReader.uint24(),
              let handshake = recordReader.take(handshakeLength)
        else { return nil }
        var reader = Reader(handshake)

        // Client version, then 32 bytes of random.
        guard reader.skip(2 + 32) else { return nil }

        // Session id, cipher suites, compression methods: all skipped by their
        // own declared lengths.
        guard let sessionIDLength = reader.byte(), reader.skip(Int(sessionIDLength)) else {
            return nil
        }
        guard let cipherSuitesLength = reader.uint16(), reader.skip(Int(cipherSuitesLength)) else {
            return nil
        }
        guard let compressionLength = reader.byte(), reader.skip(Int(compressionLength)) else {
            return nil
        }

        // Extensions. A ClientHello without any is legal and simply has no name
        // in it -- for TLS 1.3 that would be unusual, for an old client it is
        // ordinary.
        guard let extensionsLength = reader.uint16() else { return nil }
        let extensionsEnd = reader.offset + Int(extensionsLength)
        guard extensionsEnd <= data.count else { return nil }

        while reader.offset + 4 <= extensionsEnd {
            guard let type = reader.uint16(), let length = reader.uint16() else { return nil }
            let next = reader.offset + Int(length)
            guard next <= extensionsEnd else { return nil }
            if type == 0x0000 {
                return serverName(inExtension: &reader, end: next)
            }
            reader.offset = next
        }
        return nil
    }

    /// `server_name`: a list of names, of which only the host name type is
    /// defined. The first one is the answer; nothing has ever sent two.
    private static func serverName(inExtension reader: inout Reader, end: Int) -> String? {
        guard let listLength = reader.uint16() else { return nil }
        let listEnd = reader.offset + Int(listLength)
        guard listEnd <= end else { return nil }
        while reader.offset + 3 <= listEnd {
            guard let nameType = reader.byte(), let nameLength = reader.uint16() else { return nil }
            let nameEnd = reader.offset + Int(nameLength)
            guard nameEnd <= listEnd else { return nil }
            guard nameType == 0 else {
                reader.offset = nameEnd
                continue
            }
            guard let bytes = reader.take(Int(nameLength)),
                  let name = String(data: bytes, encoding: .utf8),
                  isPlausibleHostname(name)
            else { return nil }
            return name.lowercased()
        }
        return nil
    }

    /// A name that came off the wire is not automatically a name. Anything odd
    /// is discarded rather than stored and later shown as a destination.
    static func isPlausibleHostname(_ name: String) -> Bool {
        guard !name.isEmpty, name.count <= 253, name.contains(".") else { return false }
        guard !name.hasPrefix("."), !name.hasSuffix(".") else { return false }
        guard name.utf8.allSatisfy({ byte in
            (byte >= 0x61 && byte <= 0x7A)
                || (byte >= 0x41 && byte <= 0x5A)
                || (byte >= 0x30 && byte <= 0x39)
                || byte == 0x2E || byte == 0x2D
        }) else { return false }
        return name.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            !label.isEmpty && label.utf8.count <= 63
                && label.first != "-" && label.last != "-"
        }
    }

    private struct Reader {
        let data: Data
        var offset: Int

        init(_ data: Data) {
            self.data = data
            offset = data.startIndex
        }

        mutating func byte() -> UInt8? {
            guard offset < data.endIndex else { return nil }
            defer { offset += 1 }
            return data[offset]
        }

        mutating func uint16() -> UInt16? {
            guard offset + 1 < data.endIndex else { return nil }
            defer { offset += 2 }
            return UInt16(data[offset]) << 8 | UInt16(data[offset + 1])
        }

        mutating func uint24() -> Int? {
            guard offset + 2 < data.endIndex else { return nil }
            defer { offset += 3 }
            return Int(data[offset]) << 16
                | Int(data[offset + 1]) << 8
                | Int(data[offset + 2])
        }

        mutating func skip(_ count: Int) -> Bool {
            guard count >= 0, offset + count <= data.endIndex else { return false }
            offset += count
            return true
        }

        mutating func take(_ count: Int) -> Data? {
            guard count >= 0, offset + count <= data.endIndex else { return nil }
            defer { offset += count }
            return data[offset..<(offset + count)]
        }
    }
}
