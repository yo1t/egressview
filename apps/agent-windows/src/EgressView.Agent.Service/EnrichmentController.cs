using System.Text.Json;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class EnrichmentController(ObservationStore store, WindowsCredentialStore credentials) : IDisposable
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
            policy = "hub-only",
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

    private async Task FetchThreatAsync(ThreatIntelClient client, CancellationToken token)
    {
        var credential = credentials.Load();
        if (credential is null) { SetState(false, "not-enrolled", null); return; }
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
