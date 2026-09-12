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
        Func<int, int, IReadOnlyList<RecentFlow>>? recentObservations = null)
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
                "prepare-uninstall" => PrepareUninstall(root, prepareUninstall),
                _ => Reject("unknown-operation"),
            };
        }
        catch (Exception) { return Reject("malformed-request"); }
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

    private static string Reject(string reason) => JsonSerializer.Serialize(new { status = "rejected", reason });
}
