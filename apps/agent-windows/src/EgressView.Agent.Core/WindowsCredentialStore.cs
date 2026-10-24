using System.Text.Json;

namespace EgressView.Agent.Core;

public sealed class WindowsCredentialStore
{
    private const string Target = "EgressView.Agent.HubCredential";

    public void Save(AgentCredential credential)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential)) throw new ArgumentException("Invalid Agent credential.", nameof(credential));
        WindowsCredentialVault.Write(Target, credential.AgentId.ToString("D"), JsonSerializer.SerializeToUtf8Bytes(credential));
    }

    public AgentCredential? Load() => WindowsCredentialVault.Read<AgentCredential>(Target, (_, bytes) =>
    {
        var credential = JsonSerializer.Deserialize<AgentCredential>(bytes);
        return credential is not null && AgentEnrollmentClient.IsValidCredential(credential)
            ? credential : throw new InvalidDataException("Stored Agent credential is invalid.");
    });

    public void Delete() => WindowsCredentialVault.Delete(Target);
}

/// The reader's MaxMind account, kept where Windows keeps secrets.
///
/// It is stored apart from the Hub credential on purpose: a PC with no Hub is
/// exactly the case a local country table exists for, so the two must be able
/// to exist without each other. Deleting one never disturbs the other.
///
/// The account id is not a secret and goes in the user name, where Credential
/// Manager will show it; the licence key is the blob.
public sealed class MaxMindCredentialStore
{
    private const string Target = "EgressView.Agent.MaxMindAccount";

    public void Save(GeoLite2Credentials credentials)
    {
        if (!credentials.IsComplete) throw new ArgumentException("Incomplete MaxMind credentials.", nameof(credentials));
        WindowsCredentialVault.Write(Target, credentials.AccountId,
            System.Text.Encoding.UTF8.GetBytes(credentials.LicenseKey));
    }

    public GeoLite2Credentials? Load() => WindowsCredentialVault.Read<GeoLite2Credentials>(Target, (accountId, bytes) =>
    {
        var credentials = new GeoLite2Credentials(accountId, System.Text.Encoding.UTF8.GetString(bytes));
        return credentials.IsComplete ? credentials : null;
    });

    public void Delete() => WindowsCredentialVault.Delete(Target);
}

/// The person's abuse.ch Auth-Key, kept where Windows keeps secrets.
///
/// ThreatFox and URLhaus need it since 2026-10-22. Apart from the Hub
/// credential and the MaxMind account for the same reason they are apart from
/// each other: each serves a PC that may have none of the others.
public sealed class AbuseChKeyStore
{
    private const string Target = "EgressView.Agent.AbuseChAuthKey";

    public void Save(string key)
    {
        var clean = key.Trim();
        if (!IsPlausible(clean)) throw new ArgumentException("Not an abuse.ch Auth-Key.", nameof(key));
        WindowsCredentialVault.Write(Target, "abuse.ch", System.Text.Encoding.UTF8.GetBytes(clean));
    }

    public string? Load() => WindowsCredentialVault.Read<string>(Target, (_, bytes) =>
    {
        var key = System.Text.Encoding.UTF8.GetString(bytes);
        return IsPlausible(key) ? key : null;
    });

    public void Delete() => WindowsCredentialVault.Delete(Target);

    /// Printable ASCII without spaces, and not absurdly long. abuse.ch keys
    /// are about fifty hex-like characters; the check is only there so that
    /// something pasted by mistake -- a paragraph, a line break -- is refused
    /// rather than stored and sent as part of an address.
    public static bool IsPlausible(string? key) =>
        key is { Length: >= 8 and <= 256 } && key.All(character => character is > ' ' and < '\x7f');
}
