using System.Text.Json;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class EnrichmentController(ObservationStore store, WindowsCredentialStore credentials,
    string publicFeedsMarker, MaxMindCredentialStore maxMind, string countryTablePath,
    string countryTableMarker, string geoLookupSourceFile) : IDisposable
{
    private readonly SemaphoreSlim geoWake = new(0, 1);
    private readonly SemaphoreSlim threatWake = new(0, 1);
    private readonly SemaphoreSlim countryWake = new(0, 1);
    private readonly LocalCountryTable countryTable = new(countryTablePath);
    private readonly GeoLite2Updater updater = new();
    private readonly ThirdPartyGeoLookup thirdParty = new();
    private DateTimeOffset lastOnDemandHubFetch;
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
            await PlaceUnknownAddressesAsync(client, cancellationToken);
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
            thirdPartyLookup = LookupSource.UsesThirdParty(),
            publicFeedsEnabled = PublicFeedsEnabled,
            lookupSource = LookupSource.ToWire(),
            thirdPartyBudget = ThirdPartyGeoLookup.DailyBudget,
            thirdPartyRemaining = Math.Max(0, ThirdPartyGeoLookup.DailyBudget - SpentToday(now)),
            geo = new { state = gs, lastSuccessAt = geo.FetchedAt, count = geo.LocationCount,
                freshness = EnrichmentFreshness.Classify(geo.FetchedAt, TimeSpan.FromHours(24), now), lastFailure = gf },
            threat = new { state = ts, lastSuccessAt = threat.FetchedAt, count = threat.IndicatorCount,
                availability = threat.Availability, freshness = EnrichmentFreshness.Classify(threat.FetchedAt, TimeSpan.FromHours(6), now),
                source = threat.Source, lastFailure = tf },
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
            enabled = CountryTableEnabled,
            configured = account is not null,
            accountId = account?.AccountId,
            state,
            table = table.State.ToString().ToLowerInvariant(),
            builtAt = table.BuiltAt,
            databaseType = table.DatabaseType,
            expiresAt = table.BuiltAt?.Add(LocalCountryTable.MaximumAge),
            maximumAgeDays = (int)LocalCountryTable.MaximumAge.TotalDays,
            attribution = LocalCountryTable.Attribution,
            placed = store.ReadLocalCountryCount(),
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
        if (!CountryTableEnabled) { SetCountryState("off", null); return; }
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
        // The kind alone says "not a database" and stops there. The reason says
        // which part could not be read, and that difference is what turns a
        // screen saying "it failed" into one worth acting on.
        catch (GeoLite2Exception exception)
        { SetCountryState("failed", $"{exception.Kind}: {exception.Reason}".TrimEnd(':', ' ')); }
        catch (Exception exception) { SetCountryState("failed", Classify(exception)); }
    }

    /// Only the addresses nothing has placed, so a Hub's richer answer -- with
    /// coordinates the globe can draw -- is never overwritten by a country on
    /// its own.
    private void ResolveLocalCountries()
    {
        var now = DateTimeOffset.UtcNow;
        if (!CountryTableEnabled || !countryTable.Status(now).IsUsable) return;
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
        SetCountryTableEnabled(true);
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

    /// Where to look when the cache does not have an address.
    ///
    /// The Hub is the default: it has usually resolved the address already,
    /// and asking it sends nothing outside the network the Hub is on. The
    /// third party is not a default anyone gets by accident.
    internal GeoLookupSource LookupSource
    {
        get
        {
            try
            {
                if (File.Exists(geoLookupSourceFile))
                    return GeoLookupSources.Parse(File.ReadAllText(geoLookupSourceFile).Trim());
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return GeoLookupSource.Hub;
        }
    }

    internal string SetLookupSource(GeoLookupSource source)
    {
        File.WriteAllText(geoLookupSourceFile, source.ToWire() + Environment.NewLine);
        RequestNow("geo");
        return LookupSource.ToWire();
    }

    /// The Hub answers the whole cache rather than one address, so asking is a
    /// few megabytes when the tag has moved and a 304 when it has not. A
    /// minute is short enough that a country appears while the person is still
    /// looking at the map, and long enough that a burst of new destinations is
    /// one request rather than hundreds.
    private static readonly TimeSpan OnDemandInterval = TimeSpan.FromMinutes(1);

    /// The addresses the daily cache did not have.
    ///
    /// The cache is fetched once a day, so a destination reached for the first
    /// time is not in it -- and a country reached for the first time is the
    /// moment most worth seeing. That is the gap this closes.
    private async Task PlaceUnknownAddressesAsync(GeoCacheClient client, CancellationToken token)
    {
        var source = LookupSource;
        if (!source.UsesHub()) return;

        var now = DateTimeOffset.UtcNow;
        var unknown = store.ReadAddressesWithoutLocation(now.AddDays(-2), ThirdPartyGeoLookup.BatchSize);
        if (unknown.Count == 0) return;

        if (credentials.Load() is not null && now - lastOnDemandHubFetch >= OnDemandInterval)
        {
            lastOnDemandHubFetch = now;
            await FetchGeoAsync(client, token);
            unknown = store.ReadAddressesWithoutLocation(now.AddDays(-2), ThirdPartyGeoLookup.BatchSize);
            if (unknown.Count == 0) return;
        }

        if (!source.UsesThirdParty()) return;
        var remaining = (int)Math.Min(int.MaxValue, ThirdPartyGeoLookup.DailyBudget - SpentToday(now));
        if (remaining <= 0) return;
        try
        {
            var located = await thirdParty.LookUpAsync(unknown, remaining, token);
            RecordSpend(now, thirdParty.Spent);
            if (located.Count > 0) store.SaveGeoLocations(located);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception exception) { SetState(true, "failed", Classify(exception)); }
    }

    /// The budget is per day, and the day is the one the clock says now.
    ///
    /// The day is stored beside the count so that yesterday's spend cannot be
    /// read as today's: a counter alone would keep the map blank for a second
    /// day after one busy one.
    private long SpentToday(DateTimeOffset now)
    {
        var today = now.UtcDateTime.DayOfYear + now.UtcDateTime.Year * 1000;
        return store.ReadCounter("third-party-lookup-day") == today
            ? store.ReadCounter("third-party-lookups") : 0;
    }

    private void RecordSpend(DateTimeOffset now, int spent)
    {
        if (spent <= 0) return;
        var today = now.UtcDateTime.DayOfYear + now.UtcDateTime.Year * 1000;
        var already = SpentToday(now);
        store.SetCounter("third-party-lookup-day", today);
        store.SetCounter("third-party-lookups", already + spent);
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

    /// Whether this PC may use a country table at all.
    ///
    /// Separate from whether an account is stored: switching the feature off
    /// for a while should not cost someone their licence key, and removing the
    /// account is its own button.
    /// The file holds "on" or "off" rather than existing or not.
    ///
    /// Absence has to mean something too, and the useful meaning is "nobody
    /// has said": an installation that already had a MaxMind account before
    /// this switch existed is one where the person asked for the table, and
    /// an upgrade that silently turned it off would be an upgrade that took a
    /// working feature away without saying so.
    internal bool CountryTableEnabled
    {
        get
        {
            try
            {
                if (File.Exists(countryTableMarker))
                    return File.ReadAllText(countryTableMarker).TrimStart().StartsWith("on", StringComparison.Ordinal);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            return LoadMaxMindAccount() is not null;
        }
    }

    internal bool SetCountryTableEnabled(bool enabled)
    {
        File.WriteAllText(countryTableMarker, (enabled ? "on" : "off") + Environment.NewLine +
            "Written by the EgressView Agent UI." + Environment.NewLine);
        if (enabled)
        {
            lastCountryFetchAttempt = default;
            RequestNow("country");
        }
        else
        {
            // The answers go with it. An answer from a table this PC is no
            // longer allowed to consult is an answer nobody can check.
            store.ForgetLocalCountries();
            SetCountryState("off", null);
        }
        return CountryTableEnabled;
    }

    internal bool SetPublicFeedsEnabled(bool enabled)
    {
        if (enabled) File.WriteAllText(publicFeedsMarker, "Public threat feeds were enabled from the EgressView Agent UI." + Environment.NewLine);
        else File.Delete(publicFeedsMarker);
        RequestNow("threat");
        return PublicFeedsEnabled;
    }

    /// The Hub is tried first, always.
    ///
    /// The public lists are a fallback, not an alternative. Falling back the
    /// moment the Hub is slow would mean telling four feed operators that this
    /// PC exists over a blip, so it waits until the saved indicators are a day
    /// old -- by which point the Hub is not coming back on its own.
    private static readonly TimeSpan FallbackAfter = TimeSpan.FromHours(24);

    private async Task FetchThreatAsync(ThreatIntelClient client, CancellationToken token)
    {
        var credential = credentials.Load();
        if (credential is null)
        {
            // No Hub at all. The lists are the only source there is, so the
            // switch means "use them" rather than "use them when the Hub is
            // down": there is no Hub to be down.
            if (PublicFeedsEnabled) { await FetchPublicFeedsAsync(token, "public-feeds"); return; }
            SetState(false, "not-enrolled", null);
            return;
        }
        SetState(false, "fetching", null);
        try
        {
            var state = store.ReadThreatCacheState();
            var result = await client.FetchAsync(credential, state.ETag, token);
            if (result.NotModified) store.MarkThreatCacheFetched(result.ETag, DateTimeOffset.UtcNow);
            else store.ReplaceThreatIndicators(result.Available, result.Indicators, result.ETag,
                result.FetchedAt ?? DateTimeOffset.UtcNow, "hub");
            SetState(false, "idle", null);
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            SetState(false, "failed", Classify(ex));
            if (PublicFeedsEnabled && StaleEnoughToFallBack()) await FetchPublicFeedsAsync(token, "public-feeds-fallback");
        }
    }

    private bool StaleEnoughToFallBack()
    {
        var state = store.ReadThreatCacheState();
        return state.FetchedAt is null || DateTimeOffset.UtcNow - state.FetchedAt >= FallbackAfter;
    }

    /// One fetch, asked for by hand, which is not the same as agreeing to
    /// fetch from now on. The switch is left exactly as it was.
    internal async Task FetchPublicFeedsOnceAsync(CancellationToken token) =>
        await FetchPublicFeedsAsync(token, "public-feeds");

    /// The same lists the Hub reads, fetched directly.
    ///
    /// A feed that is down is ordinary and the rest still apply. A feed that
    /// downloads and parses to nothing is not ordinary -- it means the format
    /// moved -- and both are named rather than folded into a total, because on
    /// the Mac three of four feeds returned nothing for months behind a number
    /// that looked fine.
    private async Task FetchPublicFeedsAsync(CancellationToken token, string source)
    {
        SetState(false, "fetching", null);
        try
        {
            var result = await publicFeeds.DownloadAsync(token);
            store.ReplaceThreatIndicators(true, result.Indicators, null, DateTimeOffset.UtcNow, source);
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
