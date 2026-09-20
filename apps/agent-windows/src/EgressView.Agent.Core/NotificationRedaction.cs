using System.Text.RegularExpressions;

namespace EgressView.Agent.Core;

/// Keeps destinations out of a notification that appears on the desktop.
///
/// A toast is shown wherever the screen is -- a meeting room projector, a
/// shared desk, a lock screen -- so a message naming who this machine talked
/// to says it to whoever is looking. The Agent's own windows are behind the
/// session; its notifications are not.
///
/// The first rule was "any '.' or ':'", which is not a test for a destination.
/// It matched the decimal point in a size and the colon in a clock time, and
/// the outbound-anomaly notice is built from exactly those two: measured on a
/// real detection, a 2.10 GiB transfer at 12:15 was announced as "EgressView
/// Agent status changed. Open the app for details." That notification could
/// never say anything else, in any language. It also silently emptied every
/// English message in the product, because English sentences end in a period
/// and Japanese ones end in a maru.
public static partial class NotificationRedaction
{
    /// What a body says when something in it looks like a destination.
    public const string Replacement = "EgressView Agent status changed. Open the app for details.";

    public static string Apply(string body) => NamesDestination(body) ? Replacement : body;

    /// Whether this text names a machine rather than describing an amount.
    ///
    /// Deliberately a test for the three shapes a destination takes, not for
    /// punctuation. Anything matching is replaced whole rather than patched,
    /// because a half-redacted sentence invites reconstructing the rest.
    public static bool NamesDestination(string body) =>
        !string.IsNullOrEmpty(body) && (Hostname().IsMatch(body) || IPv4().IsMatch(body) || IPv6().IsMatch(body));

    /// A dotted name ending in an alphabetic label: example.com, a.b.co.uk.
    ///
    /// The trailing label must be letters, which is what keeps "2.10 GiB" and
    /// "1.5" out of it -- a number after a dot is a number.
    [GeneratedRegex(@"\b[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}\b",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Hostname();

    /// Four dotted octets. Three dots, so a size and a version stay out.
    [GeneratedRegex(@"\b\d{1,3}(\.\d{1,3}){3}\b", RegexOptions.CultureInvariant)]
    private static partial Regex IPv4();

    /// Two or more colon-separated hex groups, or the compressed form.
    ///
    /// Two colons at least, so a clock time is not an address. "12:15" has one
    /// and is left alone; "fe80::1" and "2606:4700:10::1" are not.
    [GeneratedRegex(@"(?:[0-9a-f]{1,4}:){2,}[0-9a-f]{0,4}|::[0-9a-f]{1,4}",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex IPv6();
}
