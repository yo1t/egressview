using System.Net;
using System.Net.Sockets;

namespace EgressView.Agent.Core;

/// Whether a destination was ever outside this PC.
///
/// The window is headed 「このPCで観測した外向き通信」 and its destination list
/// carried 127.0.0.1 -- on the machine this was found on, one loopback flow
/// was 41,680 rows in a day, the longest-lived flow there was. A reader either
/// believes it, and reads "this PC sends things to itself", or counts it, and
/// the 628 destinations stop being a count of where anything went.
///
/// The line is drawn at the network card, not at the router. Traffic to the
/// LAN and to multicast groups does leave this PC; it simply does not go far.
/// Only loopback never leaves, and only loopback is excluded.
public static class DestinationScope
{
    /// The same question in SQL, for the counts and the destination chart.
    ///
    /// Text matching rather than a function: remote_address is stored as the
    /// address was written, every loopback address in IPv4 begins 127. by
    /// definition, and IPv6 has exactly one. A row this misses is a row drawn
    /// as outbound, which is what the column already did for all of them.
    public static string LoopbackSql(string alias = "")
    {
        var column = alias.Length == 0 ? "remote_address" : alias + ".remote_address";
        return $"({column} LIKE '127.%' OR {column}='::1' OR {column}='0:0:0:0:0:0:0:1')";
    }

    /// Whether this address names this PC.
    public static bool IsLoopback(string? remoteAddress)
    {
        if (string.IsNullOrEmpty(remoteAddress)) return false;
        // Parsed rather than pattern-matched here, because this side has a
        // parser and the answers must agree: an address SQL calls loopback
        // and this calls outbound would be counted twice.
        if (!IPAddress.TryParse(remoteAddress, out var address)) return false;
        return IPAddress.IsLoopback(address)
            || (address.AddressFamily == AddressFamily.InterNetwork
                && address.GetAddressBytes()[0] == 127);
    }
}
