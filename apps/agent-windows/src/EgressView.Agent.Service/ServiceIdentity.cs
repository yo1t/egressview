using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;

namespace EgressView.Agent.Service;

/// The SID Windows gives this service and no other process.
///
/// NT SERVICE\EgressViewAgent is derived from the service name alone:
/// S-1-5-80- followed by the SHA-1 of the upper-cased name in UTF-16, read as
/// five little-endian integers. Computed here rather than looked up so it
/// needs no service installed to exist -- the tests use it too -- and checked
/// against `sc showsid EgressViewAgent` on the machine it was written on.
///
/// A process carries it in its token only when the service's SID type is
/// unrestricted, which the installer sets. Until then it is only a name.
internal static class ServiceIdentity
{
    public const string ServiceName = "EgressViewAgent";

    public static SecurityIdentifier Sid(string serviceName = ServiceName)
    {
        var digest = SHA1.HashData(Encoding.Unicode.GetBytes(serviceName.ToUpperInvariant()));
        var parts = Enumerable.Range(0, 5).Select(index => BitConverter.ToUInt32(digest, index * 4));
        return new SecurityIdentifier("S-1-5-80-" + string.Join('-', parts));
    }

    /// Whether this process is running as the service with its own SID.
    public static bool CarriesOwnSid(SecurityIdentifier sid) =>
        WindowsIdentity.GetCurrent().Groups?.Any(group => group.Equals(sid)) == true;
}
