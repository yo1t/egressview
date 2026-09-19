using System.Text.Json;

namespace EgressView.Agent.Core;

/// Where to look when the location cache does not have an address.
public enum GeoLookupSource
{
    /// Only what the last fetch brought. Nothing is asked for.
    CacheOnly,

    /// Ask the Hub again, off-schedule. It has usually resolved the address
    /// already, and asking it sends nothing outside the network the Hub is on.
    Hub,

    /// The Hub first, then a third party for what the Hub does not know.
    ///
    /// <b>This is the only path that sends a watched address out of the
    /// network.</b> It stays off unless someone chooses it.
    HubThenThirdParty,
}

public static class GeoLookupSources
{
    public static string ToWire(this GeoLookupSource source) => source switch
    {
        GeoLookupSource.CacheOnly => "cache-only",
        GeoLookupSource.Hub => "hub",
        _ => "hub-then-third-party",
    };

    public static GeoLookupSource Parse(string? wire) => wire switch
    {
        "cache-only" => GeoLookupSource.CacheOnly,
        "hub-then-third-party" => GeoLookupSource.HubThenThirdParty,
        _ => GeoLookupSource.Hub,
    };

    public static bool UsesHub(this GeoLookupSource source) => source != GeoLookupSource.CacheOnly;
    public static bool UsesThirdParty(this GeoLookupSource source) => source == GeoLookupSource.HubThenThirdParty;
}

/// Asks a third party where an address is, for the addresses nothing else can
/// name.
///
/// <b>This is the only path that sends a watched destination out of the
/// network</b>, which is why it runs only when someone has chosen it.
///
/// The service is `ipwho.is`, over HTTPS. The Mac's first attempt used
/// `ip-api.com`, whose free tier answers over plain HTTP only; sending watched
/// addresses in clear text was not a trade worth making for a tool whose
/// purpose is showing what leaves the machine.
public sealed class ThirdPartyGeoLookup(HttpClient? http = null, Uri? baseUri = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
{
    /// The free tier has no bulk endpoint, so this is one request per address
    /// and the count matters. Free allows 1,000 requests a day; half of that is
    /// the most this will spend, so a day of unusual browsing cannot exhaust
    /// the allowance and leave the map blank.
    public const int DailyBudget = 500;

    /// Addresses per run. Enough for a burst of new destinations, small enough
    /// that one run cannot spend the day's budget.
    public const int BatchSize = 25;

    /// One request a second. The published limits are far looser; a monitoring
    /// tool that gets itself rate-limited stops answering the question it
    /// exists to answer.
    public static readonly TimeSpan MinimumInterval = TimeSpan.FromSeconds(1);

    private readonly HttpClient http = http ?? CreateClient();
    private readonly Uri baseUri = baseUri ?? new Uri("https://ipwho.is");
    private readonly Func<TimeSpan, CancellationToken, Task> delay = delay ?? Task.Delay;

    private static HttpClient CreateClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        AgentEnrollmentClient.EnsureUserAgent(client);
        return client;
    }

    /// The address that is asked about, and nothing else.
    public Uri RequestUri(string address) =>
        new($"{baseUri.AbsoluteUri.TrimEnd('/')}/{Uri.EscapeDataString(address)}" +
            "?fields=success,ip,country_code,latitude,longitude,city");

    /// Looks addresses up one at a time and returns only the ones located.
    ///
    /// An address the service cannot place is left out rather than stored as
    /// somewhere: a wrong country on the map is worse than a missing one,
    /// because nothing tells the reader it is wrong.
    ///
    /// A failure ends the run rather than marching through the rest. The free
    /// tier carries no availability guarantee, so the service being down is an
    /// ordinary Tuesday, and the remaining addresses are still there next time.
    public async Task<IReadOnlyList<GeoLocation>> LookUpAsync(
        IReadOnlyList<string> addresses, int budget, CancellationToken cancellationToken = default)
    {
        var located = new List<GeoLocation>();
        var spent = 0;
        foreach (var address in addresses)
        {
            if (spent >= budget || spent >= BatchSize) break;
            if (spent > 0) await delay(MinimumInterval, cancellationToken);
            spent++;
            GeoLocation? location;
            try { location = await LookUpOneAsync(address, cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { throw; }
            catch (Exception) { break; }
            if (location is not null) located.Add(location);
        }
        Spent = spent;
        return located;
    }

    /// How many requests the last run actually made, including the ones that
    /// found nothing. The budget is spent by asking, not by being answered.
    public int Spent { get; private set; }

    private async Task<GeoLocation?> LookUpOneAsync(string address, CancellationToken token)
    {
        using var response = await http.GetAsync(RequestUri(address), token);
        if (!response.IsSuccessStatusCode) throw new HttpRequestException($"HTTP {(int)response.StatusCode}");
        using var document = JsonDocument.Parse(await response.Content.ReadAsByteArrayAsync(token));
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) return null;
        if (root.TryGetProperty("success", out var success) && success.ValueKind == JsonValueKind.False) return null;
        if (!root.TryGetProperty("latitude", out var lat) || !root.TryGetProperty("longitude", out var lon)) return null;
        if (!lat.TryGetDouble(out var latitude) || !lon.TryGetDouble(out var longitude)) return null;
        var country = root.TryGetProperty("country_code", out var code) && code.ValueKind == JsonValueKind.String
            ? code.GetString() : null;
        var city = root.TryGetProperty("city", out var name) && name.ValueKind == JsonValueKind.String
            ? name.GetString() : null;
        // The reply names the address it answered about. Trusting the reply's
        // own idea of which address this was would let a confused answer write
        // a location against a destination nobody asked about.
        return new GeoLocation(address, latitude, longitude, country, city);
    }
}
