using System.Net;
using System.Net.Sockets;

namespace EgressView.Agent.Core;

/// Addresses that mean something only inside this network.
///
/// Nothing outside can place them, so asking is pointless -- but the reason
/// this exists is not the wasted request. Measured on one PC, 129 of 200 recent
/// destinations were private or reserved: a home router, a printer, a work
/// subnet. Sending those to a third party would hand over the shape of the
/// reader's own network, one address at a time, in exchange for nothing. A
/// tool that watches outbound traffic must not be the thing that leaks it.
///
/// They are also excluded from the Hub's on-demand lookups, which are free but
/// not free of consequence: a set of addresses that can never be placed never
/// empties, so it would ask again every minute, for ever.
public static class PrivateAddress
{
    /// The Hub's list (src/special-use-address.js), which the Mac also carries
    /// (NonPublicAddress.swift), kept as data so each entry can be checked
    /// against the IANA registries line by line -- and a test reads the Hub's
    /// file and checks every one of its ranges is excluded here.
    ///
    /// Written as ranges since P3-128. It had been a switch over the first
    /// octet, and six of the Hub's ranges were not in it: 192.88.99.0/24 and,
    /// in IPv6, NAT64, discard-only, Teredo, documentation and 6to4. Nothing
    /// said so, because nothing compared the two.
    ///
    /// Shown is what the log's country column says for a destination in the
    /// range (P3-174). A LAN device has no country, and "unknown" put the
    /// home router beside the addresses nobody could place. The rest of the
    /// reserved ranges stay unknown: nothing on a LAN is a documentation or
    /// multicast destination one needs named.
    internal static readonly (string Network, int PrefixLength, string? Shown)[] Ranges =
    [
        ("0.0.0.0", 8, null),            // this network
        ("10.0.0.0", 8, Lan),            // private (RFC 1918)
        ("100.64.0.0", 10, Cgnat),       // shared address space / CGNAT (RFC 6598)
        ("127.0.0.0", 8, Loopback),      // loopback
        ("169.254.0.0", 16, Lan),        // link-local, incl. cloud metadata
        ("172.16.0.0", 12, Lan),         // private (RFC 1918)
        ("192.0.0.0", 24, null),         // IETF protocol assignments
        ("192.0.2.0", 24, null),         // TEST-NET-1 (documentation)
        ("192.88.99.0", 24, null),       // 6to4 relay anycast (deprecated)
        ("192.168.0.0", 16, Lan),        // private (RFC 1918)
        ("198.18.0.0", 15, null),        // benchmarking (RFC 2544)
        ("198.51.100.0", 24, null),      // TEST-NET-2 (documentation)
        ("203.0.113.0", 24, null),       // TEST-NET-3 (documentation)
        ("224.0.0.0", 4, null),          // multicast
        ("240.0.0.0", 4, null),          // reserved, incl. broadcast
        ("::", 128, null),               // unspecified
        ("::1", 128, Loopback),          // loopback
        ("64:ff9b::", 96, null),         // NAT64
        ("100::", 64, null),             // discard-only
        ("2001::", 32, null),            // Teredo
        ("2001:db8::", 32, null),        // documentation
        ("2002::", 16, null),            // 6to4
        ("fc00::", 7, Lan),              // unique local
        ("fe80::", 10, Lan),             // link-local
        ("fec0::", 10, null),            // site-local (deprecated; not in the Hub's list, kept from before)
        ("ff00::", 8, null),             // multicast
    ];

    private static readonly (byte[] Network, int PrefixLength, AddressFamily Family, string? Shown)[] parsedRanges =
        [.. Ranges.Select(range =>
        {
            var network = IPAddress.Parse(range.Network);
            return (network.GetAddressBytes(), range.PrefixLength, network.AddressFamily, range.Shown);
        })];

    public const string Lan = "LAN";
    public const string Loopback = "loopback";
    public const string Cgnat = "CGNAT";

    /// In the order the log's filter lists them.
    public static readonly IReadOnlyList<string> NetworkNames = [Lan, Loopback, Cgnat];

    public static bool IsNetworkName(string? value) => value is Lan or Loopback or Cgnat;

    /// "LAN", "loopback" or "CGNAT" for a destination in one of those ranges;
    /// null for everything else, including what does not parse. The same
    /// words in either language.
    public static string? NetworkName(string? address)
    {
        if (TryParse(address) is not { } parsed) return null;
        if (parsed.IsIPv4MappedToIPv6) parsed = parsed.MapToIPv4();
        var bytes = parsed.GetAddressBytes();
        foreach (var (network, prefix, family, shown) in parsedRanges)
            if (family == parsed.AddressFamily && Within(bytes, network, prefix)) return shown;
        return null;
    }

    /// Whether this is an address nothing outside this network can place.
    ///
    /// Something that is not an address at all is not "private or reserved",
    /// and says so: that is for the caller to decide. Routable is the caller
    /// that sends addresses out, and it decides to drop it.
    public static bool IsPrivateOrReserved(string address) =>
        TryParse(address) is { } parsed && IsPrivateOrReserved(parsed);

    public static bool IsPrivateOrReserved(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6) address = address.MapToIPv4();
        if (address.AddressFamily is not (AddressFamily.InterNetwork or AddressFamily.InterNetworkV6)) return true;
        var bytes = address.GetAddressBytes();
        foreach (var (network, prefix, family, _) in parsedRanges)
            if (family == address.AddressFamily && Within(bytes, network, prefix)) return true;
        return false;
    }

    /// <returns>Only the addresses worth asking anyone about.</returns>
    ///
    /// Something that does not parse as an address is not worth asking about
    /// either. IsPrivateOrReserved leaves that decision to its caller, and
    /// this -- the one caller that sends addresses out -- did not make it: an
    /// empty destination, which v28 kept for 6,815 peerless UDP sockets, was
    /// passed through, and the lookup asked ipwho.is about "". That service
    /// answers an empty path with the location of whoever is asking, so this
    /// PC's own location was stored under an empty key. Found in P3-128 by
    /// classifying every address the Agent had looked up.
    public static IReadOnlyList<string> Routable(IEnumerable<string> addresses) =>
        [.. addresses.Where(address => TryParse(address) is { } parsed && !IsPrivateOrReserved(parsed))];

    /// Parses an address as it may be written in a destination: bracketed, or
    /// with an IPv6 scope such as fe80::1%12. Null when it is not an address.
    private static IPAddress? TryParse(string? address)
    {
        if (string.IsNullOrWhiteSpace(address)) return null;
        var text = address.Trim().Trim('[', ']');
        return IPAddress.TryParse(text, out var parsed) ? parsed : null;
    }

    private static bool Within(byte[] address, byte[] network, int prefixLength)
    {
        var whole = prefixLength / 8;
        for (var i = 0; i < whole; i++)
            if (address[i] != network[i]) return false;
        var rest = prefixLength % 8;
        if (rest == 0) return true;
        var mask = (byte)(0xFF << (8 - rest));
        return (address[whole] & mask) == (network[whole] & mask);
    }
}
