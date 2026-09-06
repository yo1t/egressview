using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace EgressView.Agent.Core;

public sealed record ThreatIntelFetchResult(bool NotModified, bool Available, string? ETag,
    DateTimeOffset? FetchedAt, IReadOnlyList<ThreatIndicator> Indicators);

public sealed class ThreatIntelClient
{
    private readonly HttpClient http;

    public ThreatIntelClient() : this(new HttpClient(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
    }) { Timeout = TimeSpan.FromMinutes(2) }) { }

    public ThreatIntelClient(HttpClient http)
    {
        this.http = http;
        AgentEnrollmentClient.EnsureUserAgent(http);
    }

    public async Task<ThreatIntelFetchResult> FetchAsync(AgentCredential credential, string? etag,
        CancellationToken cancellationToken = default)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential))
            throw new ArgumentException("Invalid Agent credential.", nameof(credential));
        var endpoint = new Uri(credential.HubUrl.AbsoluteUri.TrimEnd('/') + "/api/agent/threat-intel");
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        if (!string.IsNullOrWhiteSpace(etag)) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        var responseEtag = response.Headers.ETag?.ToString() ?? etag;
        if (response.StatusCode == HttpStatusCode.NotModified)
            return new(true, true, responseEtag, null, []);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (!root.TryGetProperty("schemaVersion", out var schema) || schema.GetInt32() != 1 ||
            !root.TryGetProperty("available", out var availableValue) ||
            availableValue.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            throw new InvalidDataException("Unsupported threat intelligence response.");

        var available = availableValue.GetBoolean();
        var fetchedAt = root.TryGetProperty("fetchedAt", out var fetched) && fetched.ValueKind == JsonValueKind.String &&
            DateTimeOffset.TryParse(fetched.GetString(), out var parsedFetched) ? parsedFetched : (DateTimeOffset?)null;
        var indicators = new List<ThreatIndicator>();
        ReadRows(root, "ips", "ip", indicators);
        ReadRows(root, "domains", "domain", indicators);
        ReadRows(root, "cidrs", "cidr", indicators);
        return new(false, available, responseEtag, fetchedAt, indicators);
    }

    private static void ReadRows(JsonElement root, string property, string kind, List<ThreatIndicator> output)
    {
        if (!root.TryGetProperty(property, out var rows) || rows.ValueKind != JsonValueKind.Array) return;
        foreach (var row in rows.EnumerateArray())
        {
            if (row.ValueKind != JsonValueKind.Array || row.GetArrayLength() == 0 || row[0].ValueKind != JsonValueKind.String) continue;
            var value = row[0].GetString();
            if (string.IsNullOrWhiteSpace(value) || value.Length > 512) continue;
            string? TextAt(int index) => row.GetArrayLength() > index && row[index].ValueKind == JsonValueKind.String
                ? row[index].GetString() : null;
            var confidence = string.Equals(TextAt(3), "low", StringComparison.OrdinalIgnoreCase) ? "low" : "high";
            output.Add(new(kind, value, TextAt(1), TextAt(2), confidence));
        }
    }
}
