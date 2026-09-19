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
