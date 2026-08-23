import CommonCrypto
import CryptoKit
import Foundation

/// Reads the server name out of a QUIC v1 Initial packet (P3-29).
///
/// A QUIC ClientHello is encrypted, unlike a TLS one -- but with keys derived
/// from the connection ID that is in the clear on the wire, by a procedure
/// published in RFC 9001 §5.2. Anyone watching the packet can do this. It
/// reveals nothing that was protected from an observer; it recovers the same
/// name TLS puts in the clear, for a transport that happens to obscure it.
///
/// **Nothing here can read a QUIC conversation.** The Initial keys protect
/// only the handshake's first flight, and every later packet uses keys derived
/// from the TLS handshake, which an observer does not have. This decrypts one
/// packet, takes one field out of it, and stops.
///
/// Every length on the wire is attacker-controlled, so every read is bounds
/// checked and anything malformed yields nil rather than a guess. A wrong name
/// is worse than no name: the point is to label a destination, and a
/// mislabelled destination is a false statement about where traffic went.
public enum QUICInitial {
    /// RFC 9001 §5.2. Version 1 only: version 2 has a different salt, and a
    /// packet whose version this does not know is left alone rather than
    /// decrypted with the wrong key and reported as malformed.
    static let version1: UInt32 = 0x0000_0001
    static let version1Salt = Data([
        0x38, 0x76, 0x2c, 0xf7, 0xf5, 0x59, 0x34, 0xb3, 0x4d, 0x17,
        0x9a, 0xe6, 0xa4, 0xc8, 0x0c, 0xad, 0xcc, 0xbb, 0x7f, 0x0a,
    ])

    /// A connection ID is at most 20 bytes in QUIC v1, and the first datagram
    /// of a connection is at least 1200. Anything outside that is not the
    /// packet this is for.
    static let maximumConnectionIDLength = 20
    static let minimumInitialDatagram = 1200

    /// The most CRYPTO data worth reassembling. A ClientHello that needs more
    /// than the TLS parser's own limit to say a name is not one we can help,
    /// and an unbounded reassembly buffer driven by attacker-chosen offsets is
    /// a memory bug waiting to be written.
    static let maximumCryptoBytes = TLSClientHello.maximumInterestingBytes

    public static func serverName(inDatagram datagram: Data) -> String? {
        guard let packet = parseLongHeader(datagram) else { return nil }
        let keys = InitialKeys(destinationConnectionID: packet.destinationConnectionID)
        guard let plaintext = decrypt(packet: packet, keys: keys) else { return nil }
        guard let hello = reassembleCryptoFrames(plaintext) else { return nil }
        return TLSClientHello.serverName(inHandshake: hello)
    }

    // MARK: - Long header

    struct LongHeaderPacket {
        let destinationConnectionID: Data
        /// Everything before the packet-number field, plus the protected
        /// packet-number bytes; header protection covers part of both.
        let headerStart: Int
        let packetNumberOffset: Int
        let payloadEnd: Int
        let datagram: Data
    }

    static func parseLongHeader(_ datagram: Data) -> LongHeaderPacket? {
        // Padding to 1200 bytes is required of a client Initial. A shorter
        // datagram is something else, and refusing it here keeps the key
        // derivation off arbitrary UDP.
        guard datagram.count >= minimumInitialDatagram else { return nil }
        var reader = Reader(datagram)

        guard let first = reader.byte() else { return nil }
        // Long header, fixed bit set, packet type Initial (0b00).
        guard first & 0x80 != 0, first & 0x40 != 0, (first & 0x30) >> 4 == 0 else { return nil }
        guard let version = reader.uint32(), version == version1 else { return nil }

        guard let dcidLength = reader.byte(), Int(dcidLength) <= maximumConnectionIDLength,
              let dcid = reader.take(Int(dcidLength)) else { return nil }
        guard let scidLength = reader.byte(), Int(scidLength) <= maximumConnectionIDLength,
              reader.skip(Int(scidLength)) else { return nil }

        guard let tokenLength = reader.variableLengthInteger(),
              tokenLength <= UInt64(datagram.count), reader.skip(Int(tokenLength)) else { return nil }
        guard let length = reader.variableLengthInteger() else { return nil }

        let packetNumberOffset = reader.offset
        guard length >= 20 else { return nil }  // packet number + AEAD tag at minimum
        let payloadEnd = packetNumberOffset + Int(length)
        guard payloadEnd <= datagram.count else { return nil }

        return LongHeaderPacket(
            destinationConnectionID: dcid,
            headerStart: 0,
            packetNumberOffset: packetNumberOffset,
            payloadEnd: payloadEnd,
            datagram: datagram
        )
    }

    // MARK: - Keys

    struct InitialKeys {
        let key: SymmetricKey
        let iv: Data
        let headerProtection: Data

        init(destinationConnectionID: Data) {
            // RFC 9001 §5.2. The connection ID is in the clear on the wire, so
            // these keys are derivable by anyone watching the packet -- which
            // is the whole reason this is possible and also the reason it
            // reveals nothing that was protected from an observer.
            let initialSecret = HKDF<SHA256>.extract(
                inputKeyMaterial: SymmetricKey(data: destinationConnectionID),
                salt: QUICInitial.version1Salt
            )
            let client = SymmetricKey(data: QUICInitial.expandLabel(
                secret: SymmetricKey(data: Data(initialSecret)),
                label: "client in", length: 32
            ))
            key = SymmetricKey(data: QUICInitial.expandLabel(
                secret: client, label: "quic key", length: 16
            ))
            iv = QUICInitial.expandLabel(secret: client, label: "quic iv", length: 12)
            headerProtection = QUICInitial.expandLabel(
                secret: client, label: "quic hp", length: 16
            )
        }
    }

    /// TLS 1.3 HKDF-Expand-Label (RFC 8446 §7.1), which QUIC reuses with its
    /// own labels.
    static func expandLabel(secret: SymmetricKey, label: String, length: Int) -> Data {
        guard length > 0 else { return Data() }
        let full = "tls13 " + label
        var info = Data()
        info.append(UInt8(length >> 8))
        info.append(UInt8(length & 0xff))
        info.append(UInt8(full.utf8.count))
        info.append(contentsOf: Array(full.utf8))
        info.append(0)  // empty context
        let derived = HKDF<SHA256>.expand(
            pseudoRandomKey: secret, info: info, outputByteCount: length
        )
        return derived.withUnsafeBytes { Data($0) }
    }

    // MARK: - Header protection and AEAD

    /// AES-ECB over a single block. CryptoKit has no unauthenticated mode, by
    /// design; this is the one place QUIC requires one, and it is applied to a
    /// sample of ciphertext rather than to anything meaningful.
    static func headerProtectionMask(key: Data, sample: Data) -> Data? {
        guard key.count == kCCKeySizeAES128, sample.count == kCCBlockSizeAES128 else { return nil }
        var output = Data(count: kCCBlockSizeAES128)
        var moved = 0
        let status = output.withUnsafeMutableBytes { out in
            sample.withUnsafeBytes { input in
                key.withUnsafeBytes { keyBytes in
                    CCCrypt(
                        CCOperation(kCCEncrypt), CCAlgorithm(kCCAlgorithmAES),
                        CCOptions(kCCOptionECBMode),
                        keyBytes.baseAddress, kCCKeySizeAES128, nil,
                        input.baseAddress, kCCBlockSizeAES128,
                        out.baseAddress, kCCBlockSizeAES128, &moved
                    )
                }
            }
        }
        guard status == kCCSuccess, moved == kCCBlockSizeAES128 else { return nil }
        return output.prefix(5)
    }

    static func decrypt(packet: LongHeaderPacket, keys: InitialKeys) -> Data? {
        let datagram = packet.datagram
        // RFC 9001 §5.4.2: the sample starts four bytes after the packet
        // number offset, regardless of how long the packet number turns out
        // to be, because its length is not known until the header is
        // unprotected.
        let sampleStart = packet.packetNumberOffset + 4
        guard sampleStart + 16 <= packet.payloadEnd else { return nil }
        let sample = datagram.subdata(in: sampleStart..<(sampleStart + 16))
        guard let mask = headerProtectionMask(key: keys.headerProtection, sample: sample) else {
            return nil
        }

        let firstByte = datagram[datagram.startIndex] ^ (mask[mask.startIndex] & 0x0f)
        let packetNumberLength = Int(firstByte & 0x03) + 1
        guard packet.packetNumberOffset + packetNumberLength <= packet.payloadEnd else { return nil }

        var header = datagram.subdata(in: 0..<(packet.packetNumberOffset + packetNumberLength))
        header[header.startIndex] = firstByte
        var packetNumber: UInt64 = 0
        for i in 0..<packetNumberLength {
            let index = header.startIndex + packet.packetNumberOffset + i
            header[index] ^= mask[mask.startIndex + 1 + i]
            packetNumber = (packetNumber << 8) | UInt64(header[index])
        }

        // Nonce is the IV xored with the packet number, right aligned.
        var nonce = keys.iv
        for i in 0..<8 {
            let index = nonce.startIndex + nonce.count - 1 - i
            nonce[index] ^= UInt8((packetNumber >> (8 * UInt64(i))) & 0xff)
        }

        let ciphertextStart = packet.packetNumberOffset + packetNumberLength
        guard ciphertextStart + 16 <= packet.payloadEnd else { return nil }
        let ciphertext = datagram.subdata(in: ciphertextStart..<(packet.payloadEnd - 16))
        let tag = datagram.subdata(in: (packet.payloadEnd - 16)..<packet.payloadEnd)

        guard let box = try? AES.GCM.SealedBox(
            nonce: try AES.GCM.Nonce(data: nonce), ciphertext: ciphertext, tag: tag
        ) else { return nil }
        // The header is the associated data, so a tampered header fails the
        // tag rather than yielding plausible rubbish.
        return try? AES.GCM.open(box, using: keys.key, authenticating: header)
    }

    // MARK: - Frames

    /// Collects CRYPTO frames into the handshake bytes they carry.
    ///
    /// Offsets are attacker-chosen, so the reassembly buffer is bounded and a
    /// frame reaching past the bound is dropped rather than growing it.
    static func reassembleCryptoFrames(_ plaintext: Data) -> Data? {
        var reader = Reader(plaintext)
        var buffer = Data(count: maximumCryptoBytes)
        var highWater = 0
        var sawCrypto = false

        while let type = reader.byte() {
            switch type {
            case 0x00:  // PADDING
                continue
            case 0x01:  // PING
                continue
            case 0x06:  // CRYPTO
                guard let offset = reader.variableLengthInteger(),
                      let length = reader.variableLengthInteger(),
                      let payload = reader.take(Int(length)) else { return nil }
                sawCrypto = true
                let start = Int(offset)
                guard start >= 0, start + payload.count <= maximumCryptoBytes else { continue }
                buffer.replaceSubrange(
                    (buffer.startIndex + start)..<(buffer.startIndex + start + payload.count),
                    with: payload
                )
                highWater = max(highWater, start + payload.count)
            default:
                // Any other frame type in a client Initial means this is not
                // the packet being looked for, or the parse has gone wrong.
                // Stopping is better than guessing at frame lengths.
                return sawCrypto ? buffer.prefix(highWater) : nil
            }
        }
        return sawCrypto ? buffer.prefix(highWater) : nil
    }

    // MARK: - Reader

    struct Reader {
        private let data: Data
        private(set) var offset: Int

        init(_ data: Data) {
            self.data = data
            offset = 0
        }

        mutating func byte() -> UInt8? {
            guard offset < data.count else { return nil }
            defer { offset += 1 }
            return data[data.startIndex + offset]
        }

        mutating func uint32() -> UInt32? {
            guard let bytes = take(4) else { return nil }
            return bytes.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        }

        mutating func take(_ count: Int) -> Data? {
            guard count >= 0, offset + count <= data.count else { return nil }
            defer { offset += count }
            let start = data.startIndex + offset
            return data.subdata(in: start..<(start + count))
        }

        mutating func skip(_ count: Int) -> Bool { take(count) != nil }

        /// RFC 9000 §16. The top two bits give the length.
        mutating func variableLengthInteger() -> UInt64? {
            guard let first = byte() else { return nil }
            let extra = Int(1 << (first >> 6)) - 1
            var value = UInt64(first & 0x3f)
            guard let rest = take(extra) else { return nil }
            for b in rest { value = (value << 8) | UInt64(b) }
            return value
        }
    }
}
