using System.Net;

namespace EgressView.Agent.Core;

/// What came back from the public feeds, including which ones did not.
///
/// The count alone is not enough to judge by. On the Mac, three of the four
/// feeds returned nothing for the whole life of that code and the screen went
/// on showing a total, because a feed that yields no rows looks exactly like a
/// feed with nothing to report. Whoever turned it on could not tell.
public sealed record ThreatFeedResult(IReadOnlyList<ThreatIndicator> Indicators, IReadOnlyList<string> MissingSources)
{
    public bool IsComplete => MissingSources.Count == 0;
}

public sealed class ThreatFeedException(string message) : Exception(message);

/// Downloads the same public threat feeds the Hub reads, for agents that have
/// no Hub.
///
/// These are plain list downloads, not lookup services: no key, no query, and
/// <b>no destination from this PC is sent anywhere</b>. What it does reveal is
/// that this PC asked at all, which is why it stays something the person turns
/// on rather than something done for them.
///
/// Ported from the Mac Agent, feeds, parsers and judgements alike. A
/// standalone agent and a Hub-connected one must not disagree about what is
/// dangerous, and neither must the two platforms.
public sealed class ThreatFeedDownloader(HttpClient? http = null)
{
    /// The same four feeds the Hub's threat-intel reads.
    public static readonly (string Url, string Kind, string Source)[] Feeds =
    [
        ("https://feodotracker.abuse.ch/downloads/ipblocklist.csv", "feodo", "feodo"),
        ("https://threatfox.abuse.ch/export/csv/ip-port/recent/", "threatfox", "threatfox"),
        ("https://urlhaus.abuse.ch/downloads/csv_recent/", "urlhaus", "urlhaus"),
        ("https://www.spamhaus.org/drop/drop.txt", "spamhausDrop", "spamhaus"),
    ];

    /// Feeds that legitimately publish nothing for long stretches, so an empty
    /// result from them is a fact rather than a fault.
    ///
    /// Feodo Tracker's blocklist has been empty since 2026-03-04. Treating
    /// that as a broken feed would put a warning on screen that never clears,
    /// and a warning that never clears is one nobody reads.
    public static readonly IReadOnlySet<string> PublishesEmptyLists =
        new HashSet<string>(StringComparer.Ordinal) { "feodo" };

    /// Services that host other people's files.
    ///
    /// URLhaus lists the URL malware was served from. A match on one of these
    /// says something was hosted there, not that the host is hostile, so it is
    /// low confidence. The same list exists on the Hub and on the Mac.
    public static readonly IReadOnlySet<string> LowConfidenceDomains =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
            "gitlab.com", "bitbucket.org",
            "drive.google.com", "docs.google.com", "storage.googleapis.com",
            "dropbox.com", "dl.dropboxusercontent.com",
            "onedrive.live.com", "1drv.ms",
            "cdn.discordapp.com", "media.discordapp.net",
            "pastebin.com", "paste.ee",
            "transfer.sh", "anonfiles.com",
            "amazonaws.com", "s3.amazonaws.com",
            "cloudfront.net", "azureedge.net", "blob.core.windows.net",
            "archive.org",
        };

    private readonly HttpClient http = http ?? CreateClient();

    private static HttpClient CreateClient()
    {
        var client = new HttpClient(new SocketsHttpHandler
        {
            AllowAutoRedirect = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        })
        { Timeout = TimeSpan.FromMinutes(1) };
        AgentEnrollmentClient.EnsureUserAgent(client);
        return client;
    }

    public async Task<ThreatFeedResult> DownloadAsync(CancellationToken cancellationToken = default)
    {
        var indicators = new List<ThreatIndicator>();
        var missing = new List<string>();
        var anySucceeded = false;
        foreach (var (url, kind, source) in Feeds)
        {
            string text;
            try
            {
                using var response = await http.GetAsync(url, cancellationToken);
                if (response.StatusCode != HttpStatusCode.OK) { missing.Add(source); continue; }
                text = await response.Content.ReadAsStringAsync(cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception)
            {
                // One feed being down is ordinary, so the refresh continues --
                // but it is recorded rather than shrugged off.
                missing.Add(source);
                continue;
            }
            anySucceeded = true;
            var parsed = Parse(text, kind, source);
            if (parsed.Count == 0 && !PublishesEmptyLists.Contains(source))
            {
                // Downloaded and understood nothing. That is a parser or a
                // changed format, not a quiet day, and it is the exact failure
                // that went unnoticed for the life of the Mac's version.
                missing.Add(source);
                continue;
            }
            indicators.AddRange(parsed);
        }
        if (!anySucceeded) throw new ThreatFeedException("Every public threat feed failed.");
        return new ThreatFeedResult(indicators, missing);
    }

    /// Finds a column by its name in the feed's own header line.
    ///
    /// The Mac reads the malware family from a fixed index and takes the wrong
    /// column: for Feodo's `first_seen_utc,dst_ip,dst_port,c2_status,
    /// last_online,malware` it reads `last_online`, so its indicators are
    /// tagged "2026-08-01 C2". Nothing caught it because its tests assert the
    /// address and the kind and never the tag.
    ///
    /// Reading the header instead of counting commas is both correct today and
    /// unbroken by a feed that adds a column tomorrow.
    private static int ColumnIndex(string[] lines, string name)
    {
        foreach (var line in lines)
        {
            var header = line.TrimStart('#', ' ');
            var fields = CsvFields(header);
            for (var index = 0; index < fields.Count; index++)
                if (string.Equals(fields[index], name, StringComparison.OrdinalIgnoreCase)) return index;
            // Only the first non-empty line is a candidate header.
            if (header.Length > 0 && !line.TrimStart().StartsWith('#')) break;
        }
        return -1;
    }

    private static string FieldOrEmpty(List<string> fields, int index) =>
        index >= 0 && index < fields.Count ? fields[index] : string.Empty;

    public static IReadOnlyList<ThreatIndicator> Parse(string text, string kind, string source) => kind switch
    {
        "feodo" => ParseFeodo(text, source),
        "threatfox" => ParseThreatFox(text, source),
        "urlhaus" => ParseUrlhaus(text, source),
        "spamhausDrop" => ParseSpamhausDrop(text, source),
        _ => [],
    };

    private static List<ThreatIndicator> ParseFeodo(string text, string source)
    {
        var lines = Lines(text);
        var addressColumn = ColumnIndex(lines, "dst_ip");
        var malwareColumn = ColumnIndex(lines, "malware");
        if (addressColumn < 0) addressColumn = 1;
        var result = new List<ThreatIndicator>();
        foreach (var line in lines)
        {
            if (line.StartsWith('#')) continue;
            var fields = CsvFields(line);
            var address = FieldOrEmpty(fields, addressColumn);
            if (!IsPlausibleIpv4(address)) continue;
            var malware = FieldOrEmpty(fields, malwareColumn);
            result.Add(new ThreatIndicator("ip", address, source,
                malware.Length == 0 ? "botnet C2" : malware + " C2", "high"));
        }
        return result;
    }

    private static List<ThreatIndicator> ParseThreatFox(string text, string source)
    {
        var lines = Lines(text);
        var valueColumn = ColumnIndex(lines, "ioc_value");
        var malwareColumn = ColumnIndex(lines, "malware_printable");
        if (malwareColumn < 0) malwareColumn = ColumnIndex(lines, "malware");
        if (valueColumn < 0) valueColumn = 2;
        var result = new List<ThreatIndicator>();
        foreach (var line in lines)
        {
            if (line.StartsWith('#')) continue;
            var fields = CsvFields(line);
            // Strips the port: the indicator is the host, and keeping the port
            // would stop it matching the same host reached on another one.
            var value = FieldOrEmpty(fields, valueColumn).Split(':')[0];
            if (!IsPlausibleIpv4(value)) continue;
            var malware = FieldOrEmpty(fields, malwareColumn);
            result.Add(new ThreatIndicator("ip", value, source,
                malware.Length == 0 ? "malware infrastructure" : malware, "high"));
        }
        return result;
    }

    private static List<ThreatIndicator> ParseUrlhaus(string text, string source)
    {
        var lines = Lines(text);
        var urlColumn = ColumnIndex(lines, "url");
        if (urlColumn < 0) urlColumn = 2;
        var result = new List<ThreatIndicator>();
        foreach (var line in lines)
        {
            if (line.StartsWith('#')) continue;
            var fields = CsvFields(line);
            var raw = FieldOrEmpty(fields, urlColumn);
            if (raw.Length == 0 || !Uri.TryCreate(raw, UriKind.Absolute, out var uri)) continue;
            var host = uri.Host;
            if (host.Length == 0) continue;
            var isAddress = IsPlausibleIpv4(host);
            var confidence = isAddress ? "high" : ConfidenceForHost(host);
            result.Add(new ThreatIndicator(isAddress ? "ip" : "domain",
                isAddress ? host : host.ToLowerInvariant(), source,
                confidence == "low" ? "file hosting service (low confidence)" : "malware distribution",
                confidence));
        }
        return result;
    }

    private static List<ThreatIndicator> ParseSpamhausDrop(string text, string source)
    {
        var result = new List<ThreatIndicator>();
        foreach (var line in Lines(text))
        {
            var trimmed = line.Trim();
            if (trimmed.Length == 0 || trimmed.StartsWith(';') || trimmed.StartsWith('#')) continue;
            var cidr = trimmed.Split(';')[0].Trim();
            if (!IsPlausibleCidr(cidr)) continue;
            result.Add(new ThreatIndicator("cidr", cidr, source, "Spamhaus DROP (hijacked network)", "high"));
        }
        return result;
    }

    /// Matches the Hub and the Mac: the host itself, or its last two labels.
    public static string ConfidenceForHost(string host)
    {
        var lowered = host.ToLowerInvariant();
        var labels = lowered.Split('.');
        var parent = labels.Length >= 2 ? string.Join('.', labels[^2..]) : lowered;
        return LowConfidenceDomains.Contains(lowered) || LowConfidenceDomains.Contains(parent) ? "low" : "high";
    }

    /// Splits a feed into lines, whatever it ends them with.
    ///
    /// Three of the four feeds ship CRLF. On the Mac they returned zero
    /// indicators from the day that code was written until 2026-08-20, with no
    /// error anywhere: the whole download came back as one line, that line
    /// started with a comment marker, and every parser dropped it. Only
    /// Spamhaus, which ships LF, ever worked.
    public static string[] Lines(string text) =>
        text.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);

    /// Minimal RFC 4180 reader: enough for feeds that quote fields containing
    /// commas, which these do.
    public static List<string> CsvFields(string line)
    {
        var fields = new List<string>();
        var current = new System.Text.StringBuilder();
        var inQuotes = false;
        foreach (var character in line)
        {
            if (character == '"') inQuotes = !inQuotes;
            else if (character == ',' && !inQuotes) { fields.Add(current.ToString().Trim()); current.Clear(); }
            else current.Append(character);
        }
        fields.Add(current.ToString().Trim());
        return fields;
    }

    private static bool IsPlausibleIpv4(string text) =>
        IPAddress.TryParse(text, out var address) &&
        address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork;

    private static bool IsPlausibleCidr(string text)
    {
        var parts = text.Split('/');
        return parts.Length == 2 && int.TryParse(parts[1], out var prefix) && prefix is >= 0 and <= 32
            && IsPlausibleIpv4(parts[0]);
    }
}
