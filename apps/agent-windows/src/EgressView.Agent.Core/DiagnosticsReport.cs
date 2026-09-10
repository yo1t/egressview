using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace EgressView.Agent.Core;

public static class DiagnosticsReport
{
    public static string CurrentVersion => typeof(DiagnosticsReport).Assembly.GetName().Version?.ToString(3) ?? "unknown";

    public static string Create(CollectorSnapshot snapshot, ObservationStore store, string version, bool monitoringEnabled = true,
        bool verifyIntegrity = false, string reportChannel = "service-internal", DeliveryCapabilityStatus? capabilityStatus = null)
    {
        // The service verified the entire database when it opened it. Re-running
        // integrity_check for every 15-second UI status request can take minutes
        // on a multi-GB history and monopolizes the single authenticated pipe.
        var (count, integrity) = store.Inspect(verifyIntegrity);
        var coverage = store.ReadCoverage();
        var flowStats = store.ReadFlowStats();
        var processNames = store.ReadProcessNameStats();
        var delivery = store.ReadDeliveryStatus();
        var health = AgentHealth.Evaluate(snapshot, integrity);
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            version,
            build = new { version, informationalVersion = InformationalVersion(), osVersion = Environment.OSVersion.VersionString, architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() },
            collector = SafeCollector(snapshot),
            health = new { status = health.Status, issues = health.Issues.Select(issue => new { code = issue.Code, action = issue.Action }) },
            database = new { observationCount = count, storageBytes = store.ReadStorageBytes(), integrity, schemaVersion = store.SchemaVersion, durableCounters = store.ReadCounters() },
            flows = new { total = flowStats.Total, snapshot = flowStats.Snapshot, etw = flowStats.Etw, both = flowStats.Both, bytesUnknown = flowStats.BytesUnknown, processNames = new { resolved = processNames.Resolved, unresolved = processNames.Unresolved }, byOrigin = store.ReadFlowOrigins() },
            coverage = new { total = coverage.Total, active = coverage.Active, abandoned = coverage.Abandoned },
            monitoringEnabled,
            delivery = new { pending = delivery.Pending, contractRejected = delivery.ContractRejected, queueOverflow = delivery.QueueOverflow, oldestPendingAt = delivery.OldestPendingAt, lastAcknowledgedAt = delivery.LastAcknowledgedAt, capability = capabilityStatus },
            deliveryEnabled = store.DeliveryEnabled,
            ipc = new { reportChannel },
            installer = ReadInstallerState(),
            privacy = new { includesEndpoints = false, includesHostnames = false, includesProcessNames = false, includesCredentials = false, includesHubEndpoint = false, includesRawObservations = false, includesDatabase = false },
        }, new JsonSerializerOptions { WriteIndented = true });
    }

    public static string CreateFallback(string version, string failureCode) => JsonSerializer.Serialize(new
    {
        schemaVersion = 1,
        generatedAt = DateTimeOffset.UtcNow,
        build = new { version, informationalVersion = InformationalVersion(), osVersion = Environment.OSVersion.VersionString, architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() },
        service = new { reachable = false, failure = SafeCode(failureCode) },
        installer = ReadInstallerState(),
        privacy = new { includesEndpoints = false, includesHostnames = false, includesProcessNames = false, includesCredentials = false, includesHubEndpoint = false, includesRawObservations = false, includesDatabase = false },
    }, new JsonSerializerOptions { WriteIndented = true });

    private static object SafeCollector(CollectorSnapshot value) => new
    {
        value.State, value.Accepted, value.Persisted, value.QueueFullDrops, value.PersistenceFailures,
        value.LastObservedAt, value.LastPersistedAt, value.QueueCapacity, value.EtwSessionActive, value.EtwEventsSeen,
        value.EtwEventsIgnored, value.InterfaceUnresolved, value.InboundMulticastIgnored, value.EtwEventsLost,
        collectorError = SafeCode(value.CollectorError), persistenceError = SafeCode(value.PersistenceError),
        value.NamesFromStartEvents, value.NamesFromCache, value.NamesNeverSeen, value.NamesNeverSeenAtStartup,
        value.NamesNeverSeenAfterStartup, value.NamesNeverSeenAfterStartProbeMiss, value.NamesNeverSeenWithoutStartEvent,
        value.NamesInvalidProcessId, value.NamesExpired, value.NamesPidReuseRejected, value.NamesDeferredPending,
        value.NamesDeferred, value.NamesRecoveredFromStop, value.NamesDeferredExpired, value.NamesDeferredOverflow,
        processNameSourceError = SafeCode(value.ProcessNameSourceError), value.HostnamesResolved, value.HostnamesUnavailable,
        value.DnsEventsSeen, hostnameSourceError = SafeCode(value.HostnameSourceError),
    };

    private static object ReadInstallerState()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\EgressView\Agent", false);
            return new
            {
                state = key?.GetValue("InstallerState")?.ToString() ?? "not-recorded",
                version = key?.GetValue("Version")?.ToString(),
                uiPresent = key?.GetValue("UiPath") is string path && File.Exists(path),
            };
        }
        catch { return new { state = "unreadable", version = (string?)null, uiPresent = false }; }
    }

    private static string InformationalVersion() =>
        typeof(DiagnosticsReport).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion ?? CurrentVersion;

    internal static string? SafeCode(string? text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var head = text.Split(':', 2)[0];
        var safe = new string(head.Where(value => char.IsAsciiLetterOrDigit(value) || value is '-' or '_' or '.').Take(64).ToArray());
        return safe.Length == 0 ? "classified-error" : safe;
    }
}
