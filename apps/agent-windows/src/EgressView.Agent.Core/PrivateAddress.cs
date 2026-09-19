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
    public static bool IsPrivateOrReserved(string address) =>
        IPAddress.TryParse(address, out var parsed) && IsPrivateOrReserved(parsed);

    public static bool IsPrivateOrReserved(IPAddress address)
    {
        if (IPAddress.IsLoopback(address)) return true;
        if (address.AddressFamily == AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast) return true;
            // Unique local addresses, fc00::/7: the IPv6 equivalent of 10/8.
            var v6 = address.GetAddressBytes();
            if ((v6[0] & 0xFE) == 0xFC) return true;
            if (address.IsIPv4MappedToIPv6) return IsPrivateOrReserved(address.MapToIPv4());
            return address.Equals(IPAddress.IPv6Any) || address.Equals(IPAddress.IPv6None);
        }
        if (address.AddressFamily != AddressFamily.InterNetwork) return true;

        var octets = address.GetAddressBytes();
        return octets[0] switch
        {
            0 => true,                                              // "this network"
            10 => true,                                             // RFC 1918
            127 => true,                                            // loopback
            100 => octets[1] is >= 64 and <= 127,                   // RFC 6598 carrier-grade NAT
            169 => octets[1] == 254,                                // link-local
            172 => octets[1] is >= 16 and <= 31,                    // RFC 1918
            192 => octets[1] == 168                                 // RFC 1918
                || (octets[1] == 0 && octets[2] is 0 or 2),          // IETF protocol assignments, TEST-NET-1
            198 => octets[1] is 18 or 19                            // benchmarking
                || (octets[1] == 51 && octets[2] == 100),            // TEST-NET-2
            203 => octets[1] == 0 && octets[2] == 113,              // TEST-NET-3
            >= 224 => true,                                         // multicast, reserved, broadcast
            _ => false,
        };
    }

    /// <returns>Only the addresses worth asking anyone about.</returns>
    public static IReadOnlyList<string> Routable(IEnumerable<string> addresses) =>
        [.. addresses.Where(address => !IsPrivateOrReserved(address))];
}
