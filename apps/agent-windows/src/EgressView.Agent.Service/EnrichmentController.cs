using System.Text.Json;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class EnrichmentController(ObservationStore store, WindowsCredentialStore credentials,
    string publicFeedsMarker, MaxMindCredentialStore maxMind, string countryTablePath) : IDisposable
{
    private readonly SemaphoreSlim geoWake = new(0, 1);
    private readonly SemaphoreSlim threatWake = new(0, 1);
    private readonly SemaphoreSlim countryWake = new(0, 1);
    private readonly LocalCountryTable countryTable = new(countryTablePath);
    private readonly GeoLite2Updater updater = new();
    private DateTimeOffset lastCountryFetchAttempt;
    private string countryState = "idle";
    private string? countryFailure;
    private readonly object gate = new();
    private string geoState = "idle", threatState = "idle";
    private string? geoFailure, threatFailure;

    public void RequestNow(string kind)
    {
        if (kind is "geo" or "all") { lock (gate) geoState = "queued"; TryRelease(geoWake); }
        if (kind is "threat" or "all") { lock (gate) threatState = "queued"; TryRelease(threatWake); }
        if (kind is "country" or "all") TryRelease(countryWake);
        if (kind is not ("geo" or "threat" or "country" or "all")) throw new ArgumentOutOfRangeException(nameof(kind));
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
            countryTable = CountryTableStatus(now),
        });
    }

    /// The country table on this PC, and what it is allowed to say.
    ///
    /// "configured" and "state" answer different questions: an account can be
    /// set with no table yet downloaded, and a table can exist with the account
    /// since removed. Reporting one number for both is how "enabled" ends up
    /// meaning "working".
    private object CountryTableStatus(DateTimeOffset now)
    {
        var account = LoadMaxMindAccount();
        var table = countryTable.Status(now);
        string state; string? failure;
        lock (gate) { state = countryState; failure = countryFailure; }
        return new
        {
            configured = account is not null,
            accountId = account?.AccountId,
            state,
            table = table.State.ToString().ToLowerInvariant(),
            builtAt = table.BuiltAt,
            databaseType = table.DatabaseType,
            expiresAt = table.BuiltAt?.Add(LocalCountryTable.MaximumAge),
            maximumAgeDays = (int)LocalCountryTable.MaximumAge.TotalDays,
            attribution = LocalCountryTable.Attribution,
            lastFailure = failure ?? table.Failure,
        };
    }

    private GeoLite2Credentials? LoadMaxMindAccount()
    {
        try { return maxMind.Load(); }
        catch (Exception) { return null; }
    }

    /// Keeps the table current and places the addresses nobody else placed.
    ///
    /// Two jobs on one timer because they are the same job seen from either
    /// end: a table that is never refreshed stops being allowed to answer after
    /// thirty days, and a table nobody consults answers nothing regardless.
    public async Task RunCountryTableAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            await RefreshCountryTableAsync(cancellationToken);
            ResolveLocalCountries();
            await WaitAsync(countryWake, TimeSpan.FromMinutes(15), cancellationToken);
        }
    }

    private async Task RefreshCountryTableAsync(CancellationToken token)
    {
        var account = LoadMaxMindAccount();
        if (account is null) { SetCountryState("not-configured", null); return; }

        var now = DateTimeOffset.UtcNow;
        var status = countryTable.Status(now);
        // MaxMind rebuilds this edition weekly, so a table a couple of days old
        // is the current one and downloading it again would just be traffic.
        var current = status.IsUsable && status.BuiltAt is { } built && now - built < TimeSpan.FromDays(2);
        if (current) { SetCountryState("idle", null); return; }
        if (now - lastCountryFetchAttempt < TimeSpan.FromHours(6)) return;
        lastCountryFetchAttempt = now;

        SetCountryState("fetching", null);
        try
        {
            var (data, _) = await updater.FetchAsync(account, token);
            GeoLite2Updater.Install(data, countryTablePath);
            countryTable.Reload();
            SetCountryState("idle", null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (GeoLite2Exception exception) { SetCountryState("failed", exception.Kind.ToString()); }
        catch (Exception exception) { SetCountryState("failed", Classify(exception)); }
    }

    /// Only the addresses nothing has placed, so a Hub's richer answer -- with
    /// coordinates the globe can draw -- is never overwritten by a country on
    /// its own.
    private void ResolveLocalCountries()
    {
        var now = DateTimeOffset.UtcNow;
        if (!countryTable.Status(now).IsUsable) return;
        try
        {
            var unplaced = store.ReadAddressesWithoutCountry(now.AddDays(-30));
            if (unplaced.Count == 0) return;
            var answers = new List<(string Ip, string CountryCode)>();
            foreach (var address in unplaced)
                if (countryTable.CountryCode(address, now) is { } code) answers.Add((address, code));
            if (answers.Count > 0) store.SaveLocalCountries(answers);
        }
        catch (Exception exception) { SetCountryState("failed", Classify(exception)); }
    }

    /// Accepts MaxMind own GeoIP.conf, and nothing else.
    ///
    /// <returns>False when the file carries no usable account.</returns>
    internal bool SetMaxMindAccountFromConfiguration(string configuration)
    {
        var parsed = GeoLite2Credentials.FromConfiguration(configuration);
        if (parsed is null) return false;
        maxMind.Save(parsed);
        lastCountryFetchAttempt = default;
        SetCountryState("queued", null);
        RequestNow("country");
        return true;
    }

    /// Withdrawing the account withdraws the answers that came from it.
    ///
    /// The table itself is deleted too. Leaving a licensed database on disk
    /// after its reader has been switched off is the kind of copy the licence
    /// thirty-day rule exists to prevent.
    internal void ClearMaxMindAccount()
    {
        maxMind.Delete();
        countryTable.Reload();
        try { File.Delete(countryTablePath); } catch (IOException) { } catch (UnauthorizedAccessException) { }
        countryTable.Reload();
        store.ForgetLocalCountries();
        SetCountryState("not-configured", null);
    }

    private void SetCountryState(string state, string? failure)
    {
        lock (gate) { countryState = state; countryFailure = failure; }
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
    public void Dispose() { geoWake.Dispose(); threatWake.Dispose(); countryWake.Dispose(); }
}
