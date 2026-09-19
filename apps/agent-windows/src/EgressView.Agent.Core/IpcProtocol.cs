using System.Text.Json;

namespace EgressView.Agent.Core;

public static class IpcProtocol
{
    public const int Version = 1;

    public static string Handle(string request, Func<string> status, Func<int, IReadOnlyList<HourlySummary>> summary,
        Action<AgentCredential>? saveCredential = null, Action<bool>? setDeliveryEnabled = null,
        Func<int, int, IReadOnlyList<RecentFlow>>? recentFlows = null,
        Func<int, IReadOnlyList<GlobePoint>>? globePoints = null,
        Func<int, int, PeriodAnalysis>? analysis = null,
        Func<int, ThreatReport>? threats = null,
        Func<bool, bool>? setMonitoringEnabled = null,
        Func<string>? deliveryStatus = null,
        Action? requestDeliveryNow = null,
        Func<string>? enrichmentStatus = null,
        Action<string>? requestEnrichmentNow = null,
        Func<LocalHistoryStatus>? historyStatus = null,
        Func<int, LocalHistoryStatus>? setHistoryRetention = null,
        Func<DateTimeOffset?, int, int, IReadOnlyList<RecentFlow>>? historyExport = null,
        Func<DateTimeOffset?, LocalHistoryDeletionResult>? deleteHistory = null,
        Func<string>? diagnostics = null,
        Func<bool, bool, AgentUninstallResult>? prepareUninstall = null,
        Func<int?, IReadOnlyList<CountryHistoryRow>>? countryHistory = null,
        Func<int, int, IReadOnlyList<RecentFlow>>? recentObservations = null,
        Func<int, bool, ObservationPage>? logSnapshot = null,
        Func<long, int, ObservationPage>? observationsSince = null,
        Action<string, string?>? recordUiRun = null,
        Func<bool, bool>? setReadsHostnames = null,
        Func<bool, bool>? setPublicThreatFeeds = null,
        Func<string?, bool>? setCountryTableAccount = null)
    {
        try
        {
            using var document = JsonDocument.Parse(request);
            var root = document.RootElement;
            if (!root.TryGetProperty("v", out var version) || version.GetInt32() != Version)
                return Reject("version-mismatch");
            var operation = root.TryGetProperty("op", out var op) ? op.GetString() : null;
            return operation switch
            {
                "status" => Status(status),
                "summary" => Summary(root, summary),
                "recent-flows" => RecentFlows(root, recentFlows),
                // Same shape, different reading of what one row is: a
                // conversation that spans time, or one event that happened.
                "recent-observations" => RecentFlows(root, recentObservations),
                "log-snapshot" => LogSnapshot(root, logSnapshot),
                "log-delta" => LogDelta(root, observationsSince),
                "globe" => Globe(root, globePoints),
                "country-history" => CountryHistory(root, countryHistory),
                "analysis" => Analysis(root, analysis),
                "threats" => Threats(root, threats),
                "save-enrollment" => SaveEnrollment(root, saveCredential),
                "set-delivery-enabled" => SetDeliveryEnabled(root, setDeliveryEnabled),
                "set-monitoring-enabled" => SetMonitoringEnabled(root, setMonitoringEnabled),
                "delivery-status" => DynamicStatus(deliveryStatus),
                "send-delivery-now" => Invoke(requestDeliveryNow, "delivery-unavailable"),
                "enrichment-status" => DynamicStatus(enrichmentStatus),
                "refresh-enrichment" => RefreshEnrichment(root, requestEnrichmentNow),
                "history-status" => HistoryStatus(historyStatus),
                "set-history-retention" => SetHistoryRetention(root, setHistoryRetention),
                "history-export" => HistoryExport(root, historyExport),
                "delete-history" => DeleteHistory(root, deleteHistory),
                "diagnostics" => DynamicStatus(diagnostics),
                "ui-run" => UiRun(root, recordUiRun),
                "set-hostname-observation" => SetHostnameObservation(root, setReadsHostnames),
                "set-public-threat-feeds" => SetPublicThreatFeeds(root, setPublicThreatFeeds),
                "set-country-table-account" => SetCountryTableAccount(root, setCountryTableAccount),
                "prepare-uninstall" => PrepareUninstall(root, prepareUninstall),
                _ => Reject("unknown-operation"),
            };
        }
        catch (Exception) { return Reject("malformed-request"); }
    }

    /// Hands over the contents of MaxMind's own GeoIP.conf, or withdraws the
    /// account when nothing is sent.
    ///
    /// The file's text crosses the pipe rather than a parsed account, because
    /// parsing it in the window would mean the window holds the licence key in
    /// its own memory for longer than the one call it takes to pass it on. The
    /// pipe is already restricted to the signed-in user and the service.
    ///
    /// Nothing is echoed back but a yes or a no: a reply that repeated the key
    /// would put it somewhere it has no reason to be.
    private static string SetCountryTableAccount(JsonElement root, Func<string?, bool>? set)
    {
        if (set is null) return Reject("operation-unavailable");
        string? configuration = null;
        if (root.TryGetProperty("configuration", out var value))
        {
            if (value.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) return Reject("invalid-configuration");
            configuration = value.GetString();
        }
        // A file this large is not a GeoIP.conf, and reading one into the
        // service is a cost a wrong path should not be able to impose.
        if (configuration is { Length: > 64 * 1024 }) return Reject("invalid-configuration");
        try
        {
            return set(configuration)
                ? JsonSerializer.Serialize(new { status = "ok", configured = configuration is not null })
                : Reject("no-maxmind-account");
        }
        catch { return Reject("country-table-account-failed"); }
    }

    private static string PrepareUninstall(JsonElement root, Func<bool, bool, AgentUninstallResult>? prepare)
    {
        if (prepare is null) return Reject("operation-unavailable");
        var removeHistory = root.TryGetProperty("removeHistory", out var remove) && remove.ValueKind == JsonValueKind.True;
        var continueWithoutRevocation = root.TryGetProperty("continueWithoutRevocation", out var manual) && manual.ValueKind == JsonValueKind.True;
        try { return JsonSerializer.Serialize(new { status = "ok", data = prepare(removeHistory, continueWithoutRevocation) }); }
        catch (AgentUninstallException exception)
        {
            return JsonSerializer.Serialize(new { status = "rejected", reason = exception.Reason, statusCode = exception.StatusCode });
        }
        catch { return Reject("uninstall-preparation-failed"); }
    }

    private static string HistoryStatus(Func<LocalHistoryStatus>? read) => read is null
        ? Reject("operation-unavailable")
        : JsonSerializer.Serialize(new { status = "ok", data = read() });

    private static string SetHistoryRetention(JsonElement root, Func<int, LocalHistoryStatus>? set)
    {
        var days = root.TryGetProperty("days", out var value) ? value.GetInt32() : 0;
        if (set is null || !ObservationStore.AllowedRetentionDays.Contains(days)) return Reject("invalid-retention");
        try { return JsonSerializer.Serialize(new { status = "ok", data = set(days) }); }
        catch { return Reject("retention-setting-failed"); }
    }

    private static string HistoryExport(JsonElement root, Func<DateTimeOffset?, int, int, IReadOnlyList<RecentFlow>>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var limit = root.TryGetProperty("limit", out var limitValue) ? limitValue.GetInt32() : 0;
        var offset = root.TryGetProperty("offset", out var offsetValue) ? offsetValue.GetInt32() : -1;
        if (limit is < 1 or > 500 || offset is < 0 or > 10_000_000) return Reject("invalid-pagination");
        if (!TryOptionalDate(root, "before", out var before)) return Reject("invalid-cutoff");
        return JsonSerializer.Serialize(new { status = "ok", limit, offset, data = read(before, limit, offset) });
    }

    private static string DeleteHistory(JsonElement root, Func<DateTimeOffset?, LocalHistoryDeletionResult>? delete)
    {
        if (delete is null) return Reject("operation-unavailable");
        var scope = root.TryGetProperty("scope", out var value) ? value.GetString() : null;
        if (scope is not ("all" or "before")) return Reject("invalid-cutoff");
        DateTimeOffset? before = null;
        if (scope == "before" && (!TryOptionalDate(root, "before", out before) || before is null)) return Reject("invalid-cutoff");
        try { return JsonSerializer.Serialize(new { status = "ok", data = delete(before) }); }
        catch { return Reject("history-deletion-failed"); }
    }

    private static bool TryOptionalDate(JsonElement root, string property, out DateTimeOffset? value)
    {
        value = null;
        if (!root.TryGetProperty(property, out var element) || element.ValueKind == JsonValueKind.Null) return true;
        if (element.ValueKind != JsonValueKind.String || !DateTimeOffset.TryParse(element.GetString(), out var parsed)) return false;
        value = parsed.ToUniversalTime();
        return true;
    }

    private static string RefreshEnrichment(JsonElement root, Action<string>? refresh)
    {
        var kind = root.TryGetProperty("kind", out var value) ? value.GetString() : null;
        if (refresh is null || kind is not ("geo" or "threat" or "all")) return Reject("invalid-enrichment-kind");
        try { refresh(kind); return JsonSerializer.Serialize(new { status = "ok", kind }); }
        catch { return Reject("enrichment-refresh-failed"); }
    }

    private static string DynamicStatus(Func<string>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        try { return Status(read); }
        catch { return Reject("operation-failed"); }
    }

    private static string Invoke(Action? action, string failure)
    {
        if (action is null) return Reject("operation-unavailable");
        try { action(); return JsonSerializer.Serialize(new { status = "ok" }); }
        catch { return Reject(failure); }
    }

    private static string SetMonitoringEnabled(JsonElement root, Func<bool, bool>? set)
    {
        if (set is null || !root.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Reject("invalid-monitoring-setting");
        try
        {
            var enabled = set(value.GetBoolean());
            return JsonSerializer.Serialize(new { status = "ok", enabled });
        }
        catch { return Reject("monitoring-setting-failed"); }
    }

    private static string Globe(JsonElement root, Func<int, IReadOnlyList<GlobePoint>>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var minutes = ReadRangeMinutes(root);
        if (minutes == 0) return Reject("invalid-range");
        return JsonSerializer.Serialize(new { status = "ok", minutes, data = read(minutes) });
    }

    private static string CountryHistory(JsonElement root, Func<int?, IReadOnlyList<CountryHistoryRow>>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var scope = root.TryGetProperty("scope", out var value) ? value.GetString() : "period";
        if (scope == "all") return JsonSerializer.Serialize(new { status = "ok", scope, data = read(null) });
        if (scope != "period") return Reject("invalid-country-history-scope");
        var minutes = ReadRangeMinutes(root);
        if (minutes == 0) return Reject("invalid-range");
        return JsonSerializer.Serialize(new { status = "ok", scope, minutes, data = read(minutes) });
    }

    private static string Analysis(JsonElement root, Func<int, int, PeriodAnalysis>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var minutes = ReadRangeMinutes(root);
        if (minutes == 0) return Reject("invalid-range");
        var offset = root.TryGetProperty("offsetMinutes", out var offsetValue) ? offsetValue.GetInt32() : 0;
        if (offset is < 0 or > 43_200 || (offset != 0 && offset != minutes)) return Reject("invalid-offset");
        return JsonSerializer.Serialize(new { status = "ok", minutes, offsetMinutes = offset, data = read(minutes, offset) });
    }

    private static string Threats(JsonElement root, Func<int, ThreatReport>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var minutes = ReadRangeMinutes(root);
        if (minutes == 0) return Reject("invalid-range");
        return JsonSerializer.Serialize(new { status = "ok", minutes, data = read(minutes) });
    }

    private static int ReadRangeMinutes(JsonElement root)
    {
        var minutes = root.TryGetProperty("minutes", out var value) ? value.GetInt32() :
            root.TryGetProperty("days", out var days) ? days.GetInt32() * 1440 : 0;
        return minutes is 60 or 360 or 1440 or 10080 or 43200 ? minutes : 0;
    }

    private static string RecentFlows(JsonElement root, Func<int, int, IReadOnlyList<RecentFlow>>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var limit = root.TryGetProperty("limit", out var value) ? value.GetInt32() : 0;
        if (limit is not (50 or 100 or 200 or 500)) return Reject("invalid-limit");
        var offset = root.TryGetProperty("offset", out var offsetValue) ? offsetValue.GetInt32() : 0;
        if (offset is < 0 or > 1_000_000) return Reject("invalid-offset");
        return JsonSerializer.Serialize(new { status = "ok", limit, offset, data = read(limit, offset) });
    }

    private static string LogSnapshot(JsonElement root, Func<int, bool, ObservationPage>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        var limit = root.TryGetProperty("limit", out var value) ? value.GetInt32() : 0;
        if (limit is not (50 or 100 or 200 or 500)) return Reject("invalid-limit");
        var asEvents = root.TryGetProperty("events", out var events) && events.ValueKind == JsonValueKind.True;
        var page = read(limit, asEvents);
        return JsonSerializer.Serialize(new { status = "ok", limit, cursor = page.Cursor, more = page.More, data = page.Rows });
    }

    /// Bounded on purpose. This is the operation the log calls most often, and
    /// the lesson of the listener stall is that a frequently called operation
    /// must never be allowed to grow with the size of the history.
    private static string LogDelta(JsonElement root, Func<long, int, ObservationPage>? read)
    {
        if (read is null) return Reject("operation-unavailable");
        if (!root.TryGetProperty("cursor", out var cursorValue) || !cursorValue.TryGetInt64(out var cursor) || cursor < 0)
            return Reject("invalid-cursor");
        var limit = root.TryGetProperty("limit", out var value) ? value.GetInt32() : 0;
        if (limit is < 1 or > 2_000) return Reject("invalid-limit");
        var page = read(cursor, limit);
        return JsonSerializer.Serialize(new { status = "ok", limit, cursor = page.Cursor, more = page.More, data = page.Rows });
    }

    private static string SetDeliveryEnabled(JsonElement root, Action<bool>? set)
    {
        if (set is null || !root.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Reject("invalid-delivery-setting");
        try { set(value.GetBoolean()); }
        catch { return Reject("delivery-setting-failed"); }
        return JsonSerializer.Serialize(new { status = "ok", enabled = value.GetBoolean() });
    }

    private static string SaveEnrollment(JsonElement root, Action<AgentCredential>? save)
    {
        if (save is null || !root.TryGetProperty("credential", out var value)) return Reject("operation-unavailable");
        var credential = value.Deserialize<AgentCredential>();
        if (credential is null || !AgentEnrollmentClient.IsValidCredential(credential)) return Reject("invalid-credential");
        try { save(credential); }
        catch { return Reject("credential-storage-failed"); }
        return JsonSerializer.Serialize(new { status = "ok" });
    }

    private static string Status(Func<string> read)
    {
        using var document = JsonDocument.Parse(read());
        return JsonSerializer.Serialize(new { status = "ok", data = document.RootElement.Clone() });
    }

    private static string Summary(JsonElement root, Func<int, IReadOnlyList<HourlySummary>> read)
    {
        var days = root.TryGetProperty("days", out var value) ? value.GetInt32() : 0;
        if (days is not (7 or 30)) return Reject("invalid-range");
        return JsonSerializer.Serialize(new { status = "ok", days, data = read(days) });
    }

    /// The window cannot hold its own run id across a crash, so the service
    /// holds it and the window reports the three moments that change it.
    ///
    /// An unknown stage is rejected rather than ignored: "begin" arriving as
    /// "start" would leave every window run open forever, and each new one
    /// would settle the last as an unexpected end. Silence would make that
    /// look like the window really was crashing.
    private static string UiRun(JsonElement root, Action<string, string?>? record)
    {
        if (record is null) return Reject("operation-unavailable");
        var stage = root.TryGetProperty("stage", out var value) ? value.GetString() : null;
        if (stage is not ("begin" or "end" or "fault")) return Reject("invalid-run-stage");
        var fault = root.TryGetProperty("fault", out var name) && name.ValueKind == JsonValueKind.String
            ? name.GetString() : null;
        try { record(stage, fault); }
        catch { return Reject("run-record-failed"); }
        return JsonSerializer.Serialize(new { status = "ok", stage });
    }

    private static string SetHostnameObservation(JsonElement root, Func<bool, bool>? set)
    {
        if (set is null || !root.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Reject("invalid-hostname-setting");
        try { return JsonSerializer.Serialize(new { status = "ok", enabled = set(value.GetBoolean()) }); }
        catch { return Reject("hostname-setting-failed"); }
    }

    private static string SetPublicThreatFeeds(JsonElement root, Func<bool, bool>? set)
    {
        if (set is null || !root.TryGetProperty("enabled", out var value) || value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return Reject("invalid-threat-feed-setting");
        try { return JsonSerializer.Serialize(new { status = "ok", enabled = set(value.GetBoolean()) }); }
        catch { return Reject("threat-feed-setting-failed"); }
    }

    private static string Reject(string reason) => JsonSerializer.Serialize(new { status = "rejected", reason });
}
