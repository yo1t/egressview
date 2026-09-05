using System.Net;
using System.Net.Http.Headers;
using System.Text.Json;

namespace EgressView.Agent.Core;

public sealed record GeoCacheFetchResult(bool NotModified, string? ETag, IReadOnlyList<GeoLocation> Locations);

public sealed class GeoCacheClient
{
    private readonly HttpClient http;

    public GeoCacheClient() : this(new HttpClient(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
    })
    {
        Timeout = TimeSpan.FromMinutes(2),
    }) { }

    public GeoCacheClient(HttpClient http)
    {
        this.http = http;
        AgentEnrollmentClient.EnsureUserAgent(http);
    }

    public async Task<GeoCacheFetchResult> FetchAsync(AgentCredential credential, string? etag,
        CancellationToken cancellationToken = default)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential)) throw new ArgumentException("Invalid Agent credential.", nameof(credential));
        var endpoint = new Uri(credential.HubUrl.AbsoluteUri.TrimEnd('/') + "/api/agent/geo-cache");
        using var request = new HttpRequestMessage(HttpMethod.Get, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        if (!string.IsNullOrWhiteSpace(etag)) request.Headers.TryAddWithoutValidation("If-None-Match", etag);
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        var responseEtag = response.Headers.ETag?.ToString() ?? etag;
        if (response.StatusCode == HttpStatusCode.NotModified) return new(true, responseEtag, []);
        response.EnsureSuccessStatusCode();
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var document = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = document.RootElement;
        if (root.GetProperty("schemaVersion").GetInt32() != 1 || root.GetProperty("entries").ValueKind != JsonValueKind.Array)
            throw new InvalidDataException("Unsupported geo cache response.");
        var result = new List<GeoLocation>();
        foreach (var entry in root.GetProperty("entries").EnumerateArray())
        {
            if (entry.ValueKind != JsonValueKind.Array || entry.GetArrayLength() != 5) continue;
            var ip = entry[0].GetString();
            var latitude = entry[1].GetDouble();
            var longitude = entry[2].GetDouble();
            if (string.IsNullOrWhiteSpace(ip) || !double.IsFinite(latitude) || latitude is < -90 or > 90 ||
                !double.IsFinite(longitude) || longitude is < -180 or > 180) continue;
            result.Add(new(ip, latitude, longitude,
                entry[3].ValueKind == JsonValueKind.Null ? null : entry[3].GetString(),
                entry[4].ValueKind == JsonValueKind.Null ? null : entry[4].GetString()));
        }
        return new(false, responseEtag, result);
    }
}
