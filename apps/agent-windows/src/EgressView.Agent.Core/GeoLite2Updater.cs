using System.Formats.Tar;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;

namespace EgressView.Agent.Core;

public enum GeoLite2FailureKind { MissingCredentials, Unauthorised, HttpStatus, NotADatabase, Archive }

/// <param name="Reason">
/// What MaxMind said, when it said something a person can read.
///
/// The service answers a refusal with one plain sentence -- a mistyped key and
/// an account without access to this edition say different things -- and the
/// Mac used to throw that away, leaving the reader unable to tell the two
/// apart. Passing it through costs nothing.
/// </param>
public sealed class GeoLite2Exception(GeoLite2FailureKind kind, string reason) : Exception(reason)
{
    public GeoLite2FailureKind Kind { get; } = kind;
    public string Reason { get; } = reason;
}

/// The reader's own MaxMind account, as MaxMind's own file writes it.
public sealed record GeoLite2Credentials(string AccountId, string LicenseKey)
{
    public bool IsComplete => AccountId.Length > 0 && LicenseKey.Length > 0;

    /// Reads MaxMind's own `GeoIP.conf`.
    ///
    /// The portal hands one out already filled in when a licence key is
    /// created, and the key is shown exactly once. Retyping forty characters
    /// from a page you cannot revisit is where this goes wrong, so the file
    /// itself is accepted.
    ///
    /// The format is `Key Value` a line at a time, `#` starts a comment.
    /// Everything but the account and the key is ignored: `EditionIDs` is the
    /// updater tool's business, not this Agent's.
    public static GeoLite2Credentials? FromConfiguration(string configuration)
    {
        var accountId = string.Empty;
        var licenseKey = string.Empty;
        foreach (var raw in configuration.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var stripped = raw.Split('#', 2)[0];
            var parts = stripped.Split(' ', 2, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length != 2) continue;
            switch (parts[0].ToLowerInvariant())
            {
                case "accountid":
                case "userid": accountId = parts[1].Trim(); break;
                case "licensekey": licenseKey = parts[1].Trim(); break;
            }
        }
        var credentials = new GeoLite2Credentials(accountId, licenseKey);
        return credentials.IsComplete ? credentials : null;
    }
}

/// Fetches the country database using the reader's own MaxMind account.
///
/// The alternative was serving a copy from EgressView's own distribution,
/// which would put the licence's obligations on us: adopt each new build
/// promptly and destroy anything more than thirty days behind it, on behalf of
/// every installation. Letting each person use their own account keeps the
/// agreement between them and MaxMind, where it already is.
///
/// <b>What leaves the PC here is the credentials, and nothing else.</b> No
/// watched address is sent, which is the whole reason for having a local table
/// in the first place. The settings screen says so in those words.
public sealed class GeoLite2Updater(HttpClient? http = null, Uri? baseUri = null)
{
    public const string EditionId = "GeoLite2-Country";

    private readonly HttpClient http = http ?? CreateClient();
    private readonly Uri baseUri = baseUri ?? new Uri("https://download.maxmind.com/geoip/databases");

    private static HttpClient CreateClient()
    {
        var client = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = true })
        { Timeout = TimeSpan.FromMinutes(5) };
        AgentEnrollmentClient.EnsureUserAgent(client);
        return client;
    }

    /// Downloads the current build and returns the database bytes.
    ///
    /// The bytes are read as a database before they are returned. A file that
    /// does not parse never reaches the place a working one is kept: replacing
    /// a good table with a failed download would take away answers the Agent
    /// already had.
    public async Task<(byte[] Data, MaxMindMetadata Metadata)> FetchAsync(
        GeoLite2Credentials credentials, CancellationToken cancellationToken = default)
    {
        if (!credentials.IsComplete)
            throw new GeoLite2Exception(GeoLite2FailureKind.MissingCredentials, "No MaxMind account is configured.");

        var uri = new Uri($"{baseUri.AbsoluteUri.TrimEnd('/')}/{EditionId}/download?suffix=tar.gz");
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        // Basic authentication, as MaxMind's own instructions use. The key is
        // never placed in the URL: query strings end up in logs and history.
        var pair = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{credentials.AccountId}:{credentials.LicenseKey}"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Basic", pair);

        using var response = await http.SendAsync(request, cancellationToken);
        var payload = await response.Content.ReadAsByteArrayAsync(cancellationToken);
        if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            throw new GeoLite2Exception(GeoLite2FailureKind.Unauthorised, Reason(payload));
        if (response.StatusCode != HttpStatusCode.OK)
            throw new GeoLite2Exception(GeoLite2FailureKind.HttpStatus, $"HTTP {(int)response.StatusCode}. {Reason(payload)}".Trim());

        byte[] database;
        try { database = ExtractDatabase(payload); }
        catch (GeoLite2Exception) { throw; }
        catch (Exception exception)
        { throw new GeoLite2Exception(GeoLite2FailureKind.Archive, exception.GetType().Name); }

        try { return (database, new MaxMindDatabase(database).Metadata); }
        catch (MaxMindException exception)
        { throw new GeoLite2Exception(GeoLite2FailureKind.NotADatabase, exception.Kind.ToString()); }
    }

    /// Pulls the one member that matters out of the archive.
    public static byte[] ExtractDatabase(byte[] archive)
    {
        using var compressed = new MemoryStream(archive);
        using var gzip = new GZipStream(compressed, CompressionMode.Decompress);
        using var tar = new TarReader(gzip);
        while (tar.GetNextEntry() is { } entry)
        {
            if (!entry.Name.EndsWith(".mmdb", StringComparison.OrdinalIgnoreCase)) continue;
            if (entry.DataStream is null) continue;
            using var member = new MemoryStream();
            entry.DataStream.CopyTo(member);
            return member.ToArray();
        }
        throw new GeoLite2Exception(GeoLite2FailureKind.Archive, "The archive holds no database file.");
    }

    /// An error page or a body of bytes is not worth showing, so those come
    /// back empty and the caller falls back to its own words.
    public static string Reason(byte[] payload)
    {
        if (payload.Length == 0 || payload.Length > 4096) return string.Empty;
        string text;
        try { text = new UTF8Encoding(false, true).GetString(payload); }
        catch (Exception) { return string.Empty; }
        var collapsed = text.Replace('\r', ' ').Replace('\n', ' ').Trim();
        if (collapsed.Length == 0 || collapsed.StartsWith('<')) return string.Empty;
        return collapsed.Length <= 300 ? collapsed : collapsed[..300];
    }

    /// Writes the database where the Agent reads it, replacing any previous
    /// copy in one step.
    ///
    /// A half-written file is a database that reads as corrupt, and the Agent
    /// would rather keep the old one than briefly have neither.
    public static void Install(byte[] data, string path)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(path))!;
        Directory.CreateDirectory(directory);
        var incoming = Path.Combine(directory, "." + Path.GetFileName(path) + ".incoming");
        File.WriteAllBytes(incoming, data);
        File.Move(incoming, path, overwrite: true);
    }
}
