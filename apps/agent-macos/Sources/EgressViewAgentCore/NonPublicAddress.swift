import Foundation

/// Addresses that must never be sent to a location service, and that no
/// location service could answer for anyway.
///
/// The Hub has refused to send these since it first had a geo lookup
/// (`enrichment.js`: "Private, loopback, link-local, multicast and other
/// non-routable addresses must never be sent to the public GeoIP service").
/// The Agent grew its own third-party lookup without that check, and the
/// omission was not theoretical: measured on one Mac 2026-09-13, minutes after
/// install, **400 of the day's 500 requests had been spent** and the head of
/// the queue was that machine's own router and subnet, six link-local `fe80::`
/// addresses and a multicast `ff02::` address -- the local network, sent to a
/// third party, one address at a time.
///
/// Two things follow from a range being listed here:
///
///   * it is never queued, and never asked about -- of anyone, including the
///     Hub, because a round trip that cannot succeed is still a round trip; and
///   * it is not a failure to be retried. There is no answer to wait for.
///
/// The ranges are the IANA special-purpose registry, kept as data so a reader
/// can check an entry against the registry line by line, and deliberately the
/// same list the Hub uses (`src/special-use-address.js`). The test is the
/// address range and never a returned name: a name test would miss another
/// registry answering the same way.
public enum NonPublicAddress {
    /// IPv4 special-purpose ranges, as (dotted base, prefix bits).
    static let ipv4Ranges: [(String, Int)] = [
        ("0.0.0.0", 8),          // this network
        ("10.0.0.0", 8),         // private (RFC 1918)
        ("100.64.0.0", 10),      // shared address space / CGNAT (RFC 6598)
        ("127.0.0.0", 8),        // loopback
        ("169.254.0.0", 16),     // link-local, incl. cloud metadata
        ("172.16.0.0", 12),      // private (RFC 1918)
        ("192.0.0.0", 24),       // IETF protocol assignments
        ("192.0.2.0", 24),       // TEST-NET-1 (documentation)
        ("192.88.99.0", 24),     // 6to4 relay anycast (deprecated)
        ("192.168.0.0", 16),     // private (RFC 1918)
        ("198.18.0.0", 15),      // benchmarking (RFC 2544)
        ("198.51.100.0", 24),    // TEST-NET-2 (documentation)
        ("203.0.113.0", 24),     // TEST-NET-3 (documentation)
        ("224.0.0.0", 4),        // multicast
        ("240.0.0.0", 4),        // reserved, incl. broadcast
    ]

    /// IPv6 special-purpose ranges, as (base, prefix bits).
    ///
    /// IPv4-mapped addresses are absent on purpose: they are unwrapped to the
    /// embedded IPv4 address and answered by the list above, so `::ffff:10.0.0.1`
    /// and `10.0.0.1` cannot disagree.
    static let ipv6Ranges: [(String, Int)] = [
        ("::", 128),             // unspecified
        ("::1", 128),            // loopback
        ("64:ff9b::", 96),       // NAT64
        ("100::", 64),           // discard-only
        ("2001::", 32),          // Teredo
        ("2001:db8::", 32),      // documentation
        ("2002::", 16),          // 6to4
        ("fc00::", 7),           // unique local
        ("fe80::", 10),          // link-local
        ("ff00::", 8),           // multicast
    ]

    /// Whether this address is one nothing outside the network can place.
    ///
    /// Anything that is not an IP literal is `false`: a hostname is a name
    /// someone chose, and this has nothing to say about it.
    public static func isNonPublic(_ address: String) -> Bool {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard !trimmed.isEmpty else { return false }
        // A scoped link-local literal (`fe80::1%en0`) is the same address.
        let bare = trimmed.split(separator: "%", maxSplits: 1).first.map(String.init) ?? trimmed

        if let value = ipv4ToUInt32(bare) {
            return ipv4Ranges.contains { base, bits in
                guard let start = ipv4ToUInt32(base) else { return false }
                let size = UInt64(1) << UInt64(32 - bits)
                return UInt64(value) >= UInt64(start) && UInt64(value) < UInt64(start) + size
            }
        }

        // Unwrap IPv4-mapped and IPv4-compatible forms so both spellings agree.
        if let last = bare.split(separator: ":").last, last.contains("."),
           ipv4ToUInt32(String(last)) != nil {
            return isNonPublic(String(last))
        }

        guard let hex = ipv6ToHex(bare) else { return false }
        return ipv6Ranges.contains { base, bits in
            guard let baseHex = ipv6ToHex(base) else { return false }
            return sharesPrefix(hex, baseHex, bits: bits)
        }
    }

    static func ipv4ToUInt32(_ address: String) -> UInt32? {
        let parts = address.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var value: UInt32 = 0
        for part in parts {
            // `Int("01")` is 1, and so is the kernel's reading of it; what must
            // not pass is a part that is not a plain number in range.
            guard !part.isEmpty, part.allSatisfy(\.isNumber), let octet = Int(part),
                  octet >= 0, octet <= 255
            else { return nil }
            value = value << 8 | UInt32(octet)
        }
        return value
    }

    /// Expand any IPv6 form to 32 lowercase hex digits, or nil if unparseable.
    static func ipv6ToHex(_ address: String) -> String? {
        let lower = address.lowercased()
        guard lower.contains(":") else { return nil }
        let sides = lower.components(separatedBy: "::")
        guard sides.count <= 2 else { return nil }
        let head = sides[0].isEmpty ? [] : sides[0].components(separatedBy: ":")
        let tail = sides.count == 2 && !sides[1].isEmpty
            ? sides[1].components(separatedBy: ":") : []
        var parts: [String]
        if sides.count == 2 {
            let fill = 8 - head.count - tail.count
            guard fill >= 0 else { return nil }
            parts = head + Array(repeating: "0", count: fill) + tail
        } else {
            parts = head
        }
        guard parts.count == 8 else { return nil }
        var hex = ""
        for part in parts {
            guard !part.isEmpty, part.count <= 4,
                  part.allSatisfy({ $0.isHexDigit }), Int(part, radix: 16) != nil
            else { return nil }
            hex += String(repeating: "0", count: 4 - part.count) + part
        }
        return hex
    }

    static func sharesPrefix(_ left: String, _ right: String, bits: Int) -> Bool {
        let fullNibbles = bits / 4
        guard left.count == 32, right.count == 32, fullNibbles <= 32 else { return false }
        if left.prefix(fullNibbles) != right.prefix(fullNibbles) { return false }
        let remainder = bits % 4
        if remainder == 0 { return true }
        let index = left.index(left.startIndex, offsetBy: fullNibbles)
        let rightIndex = right.index(right.startIndex, offsetBy: fullNibbles)
        guard let leftValue = left[index].hexDigitValue,
              let rightValue = right[rightIndex].hexDigitValue
        else { return false }
        let mask = (0xf << (4 - remainder)) & 0xf
        return (leftValue & mask) == (rightValue & mask)
    }
}
