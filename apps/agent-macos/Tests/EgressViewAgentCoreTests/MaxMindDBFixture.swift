import Foundation
@testable import EgressViewAgentCore

/// Builds a MaxMind DB 2.0 file from a handful of prefixes.
///
/// Written from the published specification rather than borrowed, so the
/// reader is checked against the format and not against a copy of itself. It
/// only supports what these tests need: 24-bit records, one data payload per
/// prefix, no pointers in the tree's own data.
enum MaxMindDBFixture {
    struct Entry {
        let bits: [UInt8]
        let countryCode: String
    }

    /// The database both test suites share: three prefixes, IPv4, one build
    /// date.
    static func countryDatabase(buildEpoch: UInt64) -> Data {
        build(
            entries: [
                .init(bits: addressBits("1.2.0.0", prefix: 16), countryCode: "JP"),
                .init(bits: addressBits("8.8.8.0", prefix: 24), countryCode: "US"),
                .init(bits: addressBits("203.0.113.0", prefix: 24), countryCode: "AU"),
            ],
            ipVersion: 4, buildEpoch: buildEpoch
        )
    }

    static func addressBits(_ address: String, prefix: Int) -> [UInt8] {
        Array(MaxMindDB.addressBits(address)!.prefix(prefix))
    }

    private final class Node {
        var children: [Node?] = [nil, nil]
        var dataIndex: Int?
        var index = 0
    }

    static func build(
        entries: [Entry], ipVersion: Int, databaseType: String = "GeoLite2-Country",
        buildEpoch: UInt64 = 1_757_000_000
    ) -> Data {
        let root = Node()
        var payloads: [String] = []
        for entry in entries {
            var node = root
            for bit in entry.bits {
                let side = Int(bit)
                if node.children[side] == nil { node.children[side] = Node() }
                node = node.children[side]!
            }
            if let existing = payloads.firstIndex(of: entry.countryCode) {
                node.dataIndex = existing
            } else {
                payloads.append(entry.countryCode)
                node.dataIndex = payloads.count - 1
            }
        }

        // Number the interior nodes breadth-first; leaves carrying data are not
        // nodes, they are records pointing into the data section.
        var ordered: [Node] = []
        var queue: [Node] = [root]
        while let node = queue.first {
            queue.removeFirst()
            node.index = ordered.count
            ordered.append(node)
            for child in node.children where child != nil && child!.dataIndex == nil {
                queue.append(child!)
            }
        }
        let nodeCount = UInt32(ordered.count)

        // The data section, and where each payload starts inside it.
        var dataSection = Data()
        var payloadOffsets: [Int] = []
        for code in payloads {
            payloadOffsets.append(dataSection.count)
            dataSection.append(countryRecord(code))
        }

        var tree = Data()
        for node in ordered {
            for side in 0..<2 {
                let value: UInt32
                if let child = node.children[side] {
                    if let dataIndex = child.dataIndex {
                        value = UInt32(payloadOffsets[dataIndex]) + nodeCount + 16
                    } else {
                        value = UInt32(child.index)
                    }
                } else {
                    value = nodeCount  // nothing here
                }
                tree.append(UInt8((value >> 16) & 0xFF))
                tree.append(UInt8((value >> 8) & 0xFF))
                tree.append(UInt8(value & 0xFF))
            }
        }

        var file = tree
        file.append(Data(repeating: 0, count: 16))
        file.append(dataSection)
        file.append(Data([0xAB, 0xCD, 0xEF]))
        file.append(Data("MaxMind.com".utf8))
        file.append(metadata(
            nodeCount: nodeCount, ipVersion: ipVersion,
            databaseType: databaseType, buildEpoch: buildEpoch
        ))
        return file
    }

    /// `{"country": {"iso_code": "XX"}}`
    static func countryRecord(_ code: String) -> Data {
        var data = Data([0xE1])                       // map, 1 pair
        data.append(string("country"))
        data.append(Data([0xE1]))                     // map, 1 pair
        data.append(string("iso_code"))
        data.append(string(code))
        return data
    }

    static func string(_ value: String) -> Data {
        let utf8 = Array(value.utf8)
        precondition(utf8.count < 29, "the test builder only writes short strings")
        return Data([0x40 | UInt8(utf8.count)]) + Data(utf8)
    }

    static func uint(_ value: UInt64) -> Data {
        var bytes: [UInt8] = []
        var remaining = value
        while remaining > 0 { bytes.insert(UInt8(remaining & 0xFF), at: 0); remaining >>= 8 }
        return Data([0xC0 | UInt8(bytes.count)]) + Data(bytes)   // uint32, variable length
    }

    private static func metadata(
        nodeCount: UInt32, ipVersion: Int, databaseType: String, buildEpoch: UInt64
    ) -> Data {
        var data = Data([0xE0 | 7])                    // map, 7 pairs
        data.append(string("node_count"));   data.append(uint(UInt64(nodeCount)))
        data.append(string("record_size"));  data.append(uint(24))
        data.append(string("ip_version"));   data.append(uint(UInt64(ipVersion)))
        data.append(string("database_type")); data.append(string(databaseType))
        data.append(string("build_epoch"));  data.append(uint(buildEpoch))
        data.append(string("binary_format_major_version")); data.append(uint(2))
        data.append(string("binary_format_minor_version")); data.append(uint(0))
        return data
    }
}
