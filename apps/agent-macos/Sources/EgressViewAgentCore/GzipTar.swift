import Compression
import Foundation

/// Just enough gzip and tar to get a `.mmdb` out of what MaxMind serves.
///
/// Their binary databases come as `tar.gz` and nothing else, so an agent that
/// downloads its own copy has to open one. Two small formats, both fully
/// specified, and neither worth a dependency: this reads the members it needs
/// and refuses anything it does not recognise (P3-117).
enum GzipTar {
    enum Failure: Error, Equatable {
        case notGzip
        case truncated
        case inflateFailed
        case sizeMismatch(expected: UInt32, actual: Int)
        case memberNotFound(String)
    }

    /// Expands a gzip member. Only the fields a real gzip stream uses are
    /// honoured; the rest of the header is skipped as the format says to.
    static func gunzip(_ data: Data) throws -> Data {
        let bytes = [UInt8](data)
        guard bytes.count > 18, bytes[0] == 0x1F, bytes[1] == 0x8B, bytes[2] == 0x08 else {
            throw Failure.notGzip
        }
        let flags = bytes[3]
        var cursor = 10
        if flags & 0x04 != 0 {  // FEXTRA
            guard cursor + 2 <= bytes.count else { throw Failure.truncated }
            let length = Int(bytes[cursor]) | Int(bytes[cursor + 1]) << 8
            cursor += 2 + length
        }
        for flag in [UInt8(0x08), UInt8(0x10)] where flags & flag != 0 {  // FNAME, FCOMMENT
            while cursor < bytes.count, bytes[cursor] != 0 { cursor += 1 }
            cursor += 1
        }
        if flags & 0x02 != 0 { cursor += 2 }  // FHCRC
        guard cursor < bytes.count - 8 else { throw Failure.truncated }

        // The last four bytes are the uncompressed size, which is what the
        // buffer is sized from and then checked against.
        let tail = bytes.suffix(4)
        let expected = tail.reversed().reduce(UInt32(0)) { $0 << 8 | UInt32($1) }
        let deflated = Array(bytes[cursor..<(bytes.count - 8)])
        // A gzip stream may claim a size modulo 2^32. Nothing MaxMind ships is
        // anywhere near 4 GiB, so a generous floor is safer than trusting it.
        let capacity = max(Int(expected), deflated.count * 8, 1024 * 1024)

        var output = Data(count: capacity)
        let written = output.withUnsafeMutableBytes { destination -> Int in
            deflated.withUnsafeBufferPointer { source in
                compression_decode_buffer(
                    destination.bindMemory(to: UInt8.self).baseAddress!, capacity,
                    source.baseAddress!, source.count,
                    nil, COMPRESSION_ZLIB
                )
            }
        }
        guard written > 0 else { throw Failure.inflateFailed }
        guard written == Int(expected) else {
            throw Failure.sizeMismatch(expected: expected, actual: written)
        }
        return output.prefix(written)
    }

    /// The first member whose name ends with `suffix`.
    ///
    /// MaxMind's archive holds the database inside a dated directory, so the
    /// path is not known ahead of time and the suffix is what identifies it.
    static func member(endingWith suffix: String, inTar data: Data) throws -> Data {
        let bytes = [UInt8](data)
        var cursor = 0
        while cursor + 512 <= bytes.count {
            let header = Array(bytes[cursor..<(cursor + 512)])
            // Two zero blocks end the archive; one is enough to stop reading.
            if header.allSatisfy({ $0 == 0 }) { break }
            let name = string(header, from: 0, count: 100)
            let size = octal(header, from: 124, count: 12)
            let type = header[156]
            cursor += 512
            let isRegularFile = type == 0x30 || type == 0x00
            if isRegularFile, name.hasSuffix(suffix) {
                guard cursor + size <= bytes.count else { throw Failure.truncated }
                return data.subdata(in: cursor..<(cursor + size))
            }
            // Entries are padded to a whole number of blocks.
            cursor += (size + 511) / 512 * 512
        }
        throw Failure.memberNotFound(suffix)
    }

    private static func string(_ bytes: [UInt8], from offset: Int, count: Int) -> String {
        let slice = bytes[offset..<min(offset + count, bytes.count)]
        let trimmed = slice.prefix { $0 != 0 }
        return String(decoding: trimmed, as: UTF8.self)
    }

    private static func octal(_ bytes: [UInt8], from offset: Int, count: Int) -> Int {
        let text = string(bytes, from: offset, count: count)
            .trimmingCharacters(in: .whitespaces)
        return Int(text, radix: 8) ?? 0
    }
}
