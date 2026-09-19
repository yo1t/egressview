using System.Text.Json;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class EnrichmentController(ObservationStore store, WindowsCredentialStore credentials, string publicFeedsMarker) : IDisposable
{
    private readonly SemaphoreSlim geoWake = new(0, 1);
    private readonly SemaphoreSlim threatWake = new(0, 1);
    private readonly object gate = new();
    private string geoState = "idle", threatState = "idle";
    private string? geoFailure, threatFailure;

    public void RequestNow(string kind)
    {
        if (kind is "geo" or "all") { lock (gate) geoState = "queued"; TryRelease(geoWake); }
        if (kind is "threat" or "all") { lock (gate) threatState = "queued"; TryRelease(threatWake); }
        if (kind is not ("geo" or "threat" or "all")) throw new ArgumentOutOfRangeException(nameof(kind));
    }

    public async Task RunGeoAsync(CancellationToken cancellationToken)
    {
        var client = new GeoCacheClient();
        while (!cancellationToken.IsCancellationRequested)
        {
            var state = store.ReadGeoCacheState();
            if (state.FetchedAt is null || DateTimeOffset.UtcNow - state.FetchedAt >= TimeSpan.FromHours(24))
                await FetchGeoAsync(client, cancellationToken);
            await WaitAsync(geoWake, TimeSpan.FromMinutes(15), cancellationToken);
            if (geoWake.CurrentCount == 0 && GetState(true) == "queued") await FetchGeoAsync(client, cancellationToken);
        }
    }

    public async Task RunThreatAsync(CancellationToken cancellationToken)
    {
        var client = new ThreatIntelClient();
        while (!cancellationToken.IsCancellationRequested)
        {
            var state = store.ReadThreatCacheState();
            if (state.FetchedAt is null || DateTimeOffset.UtcNow - state.FetchedAt >= TimeSpan.FromHours(6))
                await FetchThreatAsync(client, cancellationToken);
            await WaitAsync(threatWake, TimeSpan.FromMinutes(15), cancellationToken);
            if (threatWake.CurrentCount == 0 && GetState(false) == "queued") await FetchThreatAsync(client, cancellationToken);
        }
    }

    public string Status()
    {
        var credential = credentials.Load();
        var geo = store.ReadGeoCacheState();
        var threat = store.ReadThreatCacheState();
        string gs, ts; string? gf, tf;
        lock (gate) { gs = geoState; ts = threatState; gf = geoFailure; tf = threatFailure; }
        var now = DateTimeOffset.UtcNow;
        return JsonSerializer.Serialize(new
        {
            enrolled = credential is not null,
            source = credential is null ? null : credential.HubUrl.GetLeftPart(UriPartial.Authority),
            policy = credential is null && PublicFeedsEnabled ? "public-feeds" : "hub-only",
            publicFeedsEnabled = PublicFeedsEnabled,
            geo = new { state = gs, lastSuccessAt = geo.FetchedAt, count = geo.LocationCount,
                freshness = EnrichmentFreshness.Classify(geo.FetchedAt, TimeSpan.FromHours(24), now), lastFailure = gf },
            threat = new { state = ts, lastSuccessAt = threat.FetchedAt, count = threat.IndicatorCount,
                availability = threat.Availability, freshness = EnrichmentFreshness.Classify(threat.FetchedAt, TimeSpan.FromHours(6), now), lastFailure = tf },
        });
    }

    private async Task FetchGeoAsync(GeoCacheClient client, CancellationToken token)
    {
        var credential = credentials.Load();
        if (credential is null) { SetState(true, "not-enrolled", null); return; }
        SetState(true, "fetching", null);
        try
        {
            var state = store.ReadGeoCacheState();
            var result = await client.FetchAsync(credential, state.ETag, token);
            if (result.NotModified) store.MarkGeoCacheFetched(result.ETag, DateTimeOffset.UtcNow);
            else store.ReplaceGeoLocations(result.Locations, result.ETag, DateTimeOffset.UtcNow);
            SetState(true, "idle", null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception ex) { SetState(true, "failed", Classify(ex)); }
    }

    /// Whether this PC may fetch the public threat feeds itself.
    ///
    /// Off until someone says otherwise. The download sends no destination
    /// anywhere -- it is a plain list fetch -- but it does reveal that this PC
    /// asked, and that is not a thing to decide on someone's behalf.
    internal bool PublicFeedsEnabled => File.Exists(publicFeedsMarker);

    internal bool SetPublicFeedsEnabled(bool enabled)
    {
        if (enabled) File.WriteAllText(publicFeedsMarker, "Public threat feeds were enabled from the EgressView Agent UI." + Environment.NewLine);
        else File.Delete(publicFeedsMarker);
        RequestNow("threat");
        return PublicFeedsEnabled;
    }

    private async Task FetchThreatAsync(ThreatIntelClient client, CancellationToken token)
    {
        var credential = credentials.Load();
        if (credential is null)
        {
            // No Hub. Either the person asked this PC to fetch the lists
            // itself, or there is nothing to match against and the screen
            // should say so rather than showing an empty threat tab.
            if (PublicFeedsEnabled) { await FetchPublicFeedsAsync(token); return; }
            SetState(false, "not-enrolled", null);
            return;
        }
        SetState(false, "fetching", null);
        try
        {
            var state = store.ReadThreatCacheState();
            var result = await client.FetchAsync(credential, state.ETag, token);
            if (result.NotModified) store.MarkThreatCacheFetched(result.ETag, DateTimeOffset.UtcNow);
            else store.ReplaceThreatIndicators(result.Available, result.Indicators, result.ETag, result.FetchedAt ?? DateTimeOffset.UtcNow);
            SetState(false, "idle", null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception ex) { SetState(false, "failed", Classify(ex)); }
    }

    /// The same lists the Hub reads, fetched directly.
    ///
    /// A feed that is down is ordinary and the rest still apply. A feed that
    /// downloads and parses to nothing is not ordinary -- it means the format
    /// moved -- and both are named rather than folded into a total, because on
    /// the Mac three of four feeds returned nothing for months behind a number
    /// that looked fine.
    private async Task FetchPublicFeedsAsync(CancellationToken token)
    {
        SetState(false, "fetching", null);
        try
        {
            var result = await publicFeeds.DownloadAsync(token);
            store.ReplaceThreatIndicators(true, result.Indicators, null, DateTimeOffset.UtcNow);
            SetState(false, result.IsComplete ? "idle" : "partial",
                result.IsComplete ? null : "missing-feeds:" + string.Join('+', result.MissingSources));
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (ThreatFeedException) { SetState(false, "failed", "all-feeds-failed"); }
        catch (Exception ex) { SetState(false, "failed", Classify(ex)); }
    }

    private readonly ThreatFeedDownloader publicFeeds = new();

    private string GetState(bool geo) { lock (gate) return geo ? geoState : threatState; }
    private void SetState(bool geo, string state, string? failure)
    {
        lock (gate) { if (geo) { geoState = state; geoFailure = failure; } else { threatState = state; threatFailure = failure; } }
    }
    private static string Classify(Exception ex) => ex is HttpRequestException http && http.StatusCode is { } code
        ? $"http-{(int)code}" : ex is TaskCanceledException ? "timeout" : "connection-failed";
    private static void TryRelease(SemaphoreSlim semaphore) { if (semaphore.CurrentCount == 0) semaphore.Release(); }
    private static async Task WaitAsync(SemaphoreSlim semaphore, TimeSpan delay, CancellationToken token)
    {
        try { await semaphore.WaitAsync(delay, token); }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { }
    }
    public void Dispose() { geoWake.Dispose(); threatWake.Dispose(); }
}
