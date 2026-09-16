import Foundation

/// Reads a MaxMind DB file (`.mmdb`) well enough to answer "which country is
/// this address in", and nothing more.
///
/// The point is to stop asking anyone. Today a country the cache does not hold
/// is fetched from the Hub, or -- if someone chose it -- from a third party
/// that is told the address being watched (P3-115). A table on this Mac ends
/// both: the question never leaves the machine (P3-117).
///
/// Only the country is read. The globe draws arcs to coordinates, and the
/// country database has none; that stays with the Hub, and the limit is stated
/// rather than papered over.
///
/// The format is MaxMind DB 2.0, whose specification is public. Three parts,
/// in this order: a binary search tree over the address bits, sixteen zero
/// bytes, and a data section. The metadata sits at the end behind a marker.
public struct MaxMindDB: Sendable {
    public enum Failure: Error, Equatable {
        case unreadable(String)
        case noMetadata
        case malformedMetadata(String)
        case unsupportedRecordSize(Int)
        case corruptTree(String)
    }

    /// What the file says about itself. `buildEpoch` is the part that matters
    /// operationally: the licence requires moving to a new build and destroying
    /// the old one within thirty days, so the agent has to be able to say how
    /// old its copy is.
    public struct Metadata: Equatable, Sendable {
        public let nodeCount: UInt32
        public let recordSize: Int
        public let ipVersion: Int
        public let databaseType: String
        public let buildEpoch: UInt64
        public let majorVersion: UInt16
        public let minorVersion: UInt16

        public var builtAt: Date { Date(timeIntervalSince1970: TimeInterval(buildEpoch)) }
        public func age(now: Date = Date()) -> TimeInterval { now.timeIntervalSince(builtAt) }
    }

    private static let metadataMarker = Data([0xAB, 0xCD, 0xEF]) + Data("MaxMind.com".utf8)
    /// The specification puts the metadata within the last 128 KiB.
    private static let metadataSearchWindow = 128 * 1024

    private let bytes: Data
    public let metadata: Metadata
    private let searchTreeSize: Int
    private let dataSectionStart: Int
    /// Where an IPv4 lookup starts in an IPv6 tree: the node reached by
    /// walking ninety-six zero bits. Found once, because every IPv4 lookup
    /// would otherwise repeat the same ninety-six steps.
    private let ipv4StartNode: UInt32

    public init(contentsOf url: URL) throws {
        do {
            // Mapped rather than read: the country database is a few megabytes
            // and only a handful of its pages are ever touched.
            try self.init(bytes: Data(contentsOf: url, options: .mappedIfSafe))
        } catch let failure as Failure {
            throw failure
        } catch {
            throw Failure.unreadable(error.localizedDescription)
        }
    }

    public init(bytes: Data) throws {
        self.bytes = bytes
        let metadataStart = try Self.locateMetadata(in: bytes)
        self.metadata = try Self.readMetadata(from: bytes, at: metadataStart)
        guard [24, 28, 32].contains(metadata.recordSize) else {
            throw Failure.unsupportedRecordSize(metadata.recordSize)
        }
        self.searchTreeSize = Int(metadata.nodeCount) * metadata.recordSize * 2 / 8
        // Sixteen zero bytes separate the tree from the data section.
        self.dataSectionStart = searchTreeSize + 16
        guard dataSectionStart <= bytes.count else {
            throw Failure.corruptTree("the search tree does not fit in the file")
        }
        self.ipv4StartNode = metadata.ipVersion == 6
            ? try Self.walkZeroBits(96, bytes: bytes, metadata: metadata, treeSize: searchTreeSize)
            : 0
    }

    /// The ISO country code for an address, or nil when the database has no
    /// answer for it.
    ///
    /// A missing answer is not an error: private ranges, unassigned space and
    /// addresses the database simply does not place all arrive here, and a
    /// country nobody knows is better shown as unknown than guessed.
    public func countryCode(for address: String) throws -> String? {
        guard let record = try lookup(address) else { return nil }
        guard case let .map(fields) = record else { return nil }
        // GeoLite2-Country nests it: {"country": {"iso_code": "JP"}}. The
        // registered country is the fallback -- for an address assigned to one
        // country and used in another, the assignment is the honest answer when
        // nothing better exists.
        for key in ["country", "registered_country"] {
            if case let .map(country)? = fields[key],
               case let .string(code)? = country["iso_code"],
               code.count == 2 {
                return code.uppercased()
            }
        }
        return nil
    }

    /// The whole record for an address, for callers that want more than the
    /// country.
    public func lookup(_ address: String) throws -> Value? {
        guard let bits = Self.addressBits(address) else { return nil }
        let startNode: UInt32
        let walk: [UInt8]
        if bits.count == 32 && metadata.ipVersion == 6 {
            startNode = ipv4StartNode
            walk = bits
        } else if bits.count == 128 && metadata.ipVersion == 4 {
            // An IPv6 address in an IPv4-only database is not an error; it is
            // simply not in there.
            return nil
        } else {
            startNode = 0
            walk = bits
        }
        guard let offset = try Self.resolve(
            walk, from: startNode, bytes: bytes, metadata: metadata, treeSize: searchTreeSize
        ) else { return nil }
        var decoder = Decoder(bytes: bytes, dataSectionStart: dataSectionStart)
        return try decoder.value(at: dataSectionStart + Int(offset))
    }

    // MARK: - Tree

    private static func walkZeroBits(
        _ count: Int, bytes: Data, metadata: Metadata, treeSize: Int
    ) throws -> UInt32 {
        var node: UInt32 = 0
        for _ in 0..<count {
            guard node < metadata.nodeCount else { return node }
            node = try record(node: node, bit: 0, bytes: bytes, metadata: metadata)
        }
        return node
    }

    /// Walks the address bits and returns the data-section offset, if the tree
    /// ends at data rather than at "no answer".
    private static func resolve(
        _ bits: [UInt8], from startNode: UInt32, bytes: Data, metadata: Metadata, treeSize: Int
    ) throws -> UInt32? {
        var node = startNode
        for bit in bits {
            if node >= metadata.nodeCount { break }
            node = try record(node: node, bit: bit, bytes: bytes, metadata: metadata)
        }
        // Equal to the node count is the documented way of saying "nothing
        // here", and is not a corrupt file.
        if node == metadata.nodeCount { return nil }
        guard node > metadata.nodeCount else {
            throw Failure.corruptTree("the walk ended inside the tree")
        }
        return node - metadata.nodeCount - 16
    }

    private static func record(
        node: UInt32, bit: UInt8, bytes: Data, metadata: Metadata
    ) throws -> UInt32 {
        let nodeSize = metadata.recordSize * 2 / 8
        let base = Int(node) * nodeSize
        guard base + nodeSize <= bytes.count else {
            throw Failure.corruptTree("node \(node) is past the end of the file")
        }
        switch metadata.recordSize {
        case 24:
            let start = base + (bit == 0 ? 0 : 3)
            return UInt32(bytes[start]) << 16 | UInt32(bytes[start + 1]) << 8 | UInt32(bytes[start + 2])
        case 32:
            let start = base + (bit == 0 ? 0 : 4)
            return UInt32(bytes[start]) << 24 | UInt32(bytes[start + 1]) << 16
                | UInt32(bytes[start + 2]) << 8 | UInt32(bytes[start + 3])
        default:
            // 28 bits each: the middle byte carries the top four bits of both
            // records -- the left record's in the high nibble.
            let middle = bytes[base + 3]
            if bit == 0 {
                return UInt32(middle >> 4) << 24 | UInt32(bytes[base]) << 16
                    | UInt32(bytes[base + 1]) << 8 | UInt32(bytes[base + 2])
            }
            return UInt32(middle & 0x0F) << 24 | UInt32(bytes[base + 4]) << 16
                | UInt32(bytes[base + 5]) << 8 | UInt32(bytes[base + 6])
        }
    }

    // MARK: - Metadata

    private static func locateMetadata(in bytes: Data) throws -> Int {
        let searchFrom = max(0, bytes.count - metadataSearchWindow)
        // The last occurrence wins: the marker may appear inside the data
        // section by coincidence, and the specification says to take the last.
        var found: Int?
        var index = searchFrom
        while index + metadataMarker.count <= bytes.count {
            if bytes[index..<(index + metadataMarker.count)].elementsEqual(metadataMarker) {
                found = index + metadataMarker.count
            }
            index += 1
        }
        guard let start = found else { throw Failure.noMetadata }
        return start
    }

    private static func readMetadata(from bytes: Data, at start: Int) throws -> Metadata {
        // The metadata is encoded in the same format as the data section, and
        // its pointers -- if any -- are relative to its own beginning.
        var decoder = Decoder(bytes: bytes, dataSectionStart: start)
        guard case let .map(fields) = try decoder.value(at: start) else {
            throw Failure.malformedMetadata("the metadata is not a map")
        }
        func number(_ key: String) throws -> UInt64 {
            guard case let .uint(value)? = fields[key] else {
                throw Failure.malformedMetadata("missing \(key)")
            }
            return value
        }
        guard case let .string(databaseType)? = fields["database_type"] else {
            throw Failure.malformedMetadata("missing database_type")
        }
        return Metadata(
            nodeCount: UInt32(truncatingIfNeeded: try number("node_count")),
            recordSize: Int(try number("record_size")),
            ipVersion: Int(try number("ip_version")),
            databaseType: databaseType,
            buildEpoch: try number("build_epoch"),
            majorVersion: UInt16(truncatingIfNeeded: try number("binary_format_major_version")),
            minorVersion: UInt16(truncatingIfNeeded: try number("binary_format_minor_version"))
        )
    }

    // MARK: - Addresses

    /// The address as bits, most significant first. Nil for anything that is
    /// not an address -- a hostname, a port, an empty string.
    static func addressBits(_ address: String) -> [UInt8]? {
        var v4 = in_addr()
        if inet_pton(AF_INET, address, &v4) == 1 {
            return bits(of: withUnsafeBytes(of: v4.s_addr) { Array($0) })
        }
        var v6 = in6_addr()
        if inet_pton(AF_INET6, address, &v6) == 1 {
            let octets = withUnsafeBytes(of: v6) { Array($0) }
            // An IPv4-mapped address is the IPv4 address: ::ffff:1.2.3.4 and
            // 1.2.3.4 must not land in different parts of the tree.
            if octets.count == 16,
               octets[0..<10].allSatisfy({ $0 == 0 }),
               octets[10] == 0xFF, octets[11] == 0xFF {
                return bits(of: Array(octets[12..<16]))
            }
            return bits(of: octets)
        }
        return nil
    }

    private static func bits(of octets: [UInt8]) -> [UInt8] {
        var result: [UInt8] = []
        result.reserveCapacity(octets.count * 8)
        for octet in octets {
            for shift in stride(from: 7, through: 0, by: -1) {
                result.append((octet >> UInt8(shift)) & 1)
            }
        }
        return result
    }
}
