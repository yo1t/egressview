using System.Text.Json;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace EgressView.Agent.Core;

public static class DiagnosticsReport
{
    public static string CurrentVersion => typeof(DiagnosticsReport).Assembly.GetName().Version?.ToString(3) ?? "unknown";

    public static string CreateStatus(CollectorSnapshot snapshot, ObservationStore store, string version,
        bool monitoringEnabled = true, bool readsHostnames = true)
    {
        // Status is polled by both the tray and the open window. Keep it independent
        // of history size: full table counts belong to the explicit diagnostics and
        // analysis operations, and can take longer than the IPC lifetime on a multi-GB DB.
        var coverage = store.ReadCoverage();
        var health = AgentHealth.Evaluate(snapshot, "ok");
        return JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            generatedAt = DateTimeOffset.UtcNow,
            version,
            build = new { version, informationalVersion = InformationalVersion(), osVersion = Environment.OSVersion.VersionString, architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() },
            health = new { status = health.Status, issues = health.Issues.Select(issue => new { code = issue.Code, action = issue.Action }) },
            coverage = new { total = coverage.Total, active = coverage.Active, abandoned = coverage.Abandoned },
            monitoringEnabled,
            readsHostnames,
            deliveryEnabled = store.DeliveryEnabled,
            // Cheap: one indexed row. The window needs to know that something
            // was judged unusual, and a count alone cannot tell a new finding
            // from an old one already seen.
            outboundAnomaly = SafeLatestAnomaly(store),
        });
    }

    private static object? SafeLatestAnomaly(ObservationStore store)
    {
        try
        {
            return store.ReadLatestOutboundAnomaly() is not { } latest ? null : new
            {
                windowStart = latest.WindowStart,
                kind = latest.Kind == OutboundAnomalyKind.DistributedTransfer ? "distributed-transfer" : "large-transfer",
                bytesOut = latest.BytesOut,
            };
        }
        catch (Exception) { return null; }
    }

    public static string Create(CollectorSnapshot snapshot, ObservationStore store, string version, bool monitoringEnabled = true,
        bool verifyIntegrity = false, string reportChannel = "service-internal", DeliveryCapabilityStatus? capabilityStatus = null,
        DeliveryRuntimeStatus? deliveryRuntime = null)
    {
        // The service verified the entire database when it opened it. Re-running
        // integrity_check for every 15-second UI status request can take minutes
        // on a multi-GB history and monopolizes the single authenticated pipe.
        // Verifying reads every page: thirty seconds warm, two minutes cold,
        // all of it holding the lock every other request needs, on a pipe that
        // takes one caller at a time. The offline bundle -- run when the
        // service will not start, with nobody waiting on it -- asks for that.
        // A request over IPC must not, and reports what the last full read
        // found and when instead.
        var (count, verified) = store.Inspect(verifyIntegrity);
        var integrity = verifyIntegrity ? verified : store.LastVerifiedIntegrity;
        var integrityCheckedAt = store.LastDeepIntegrityCheckAt;
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
            // What happened to the last few runs of each process. A report
            // that only describes the agent that is running cannot answer the
            // question people actually ask after a silent gap.
            runs = SafeRuns(store),
            // "three unexpected endings" and "one crash, two reboots" are the
            // same number and different news. Without the split, the one run
            // that really failed is read at the same weight as the machine
            // being restarted, and on a laptop the restarts always win.
            runSummary = SafeRunSummary(store),
            health = new { status = health.Status, issues = health.Issues.Select(issue => new { code = issue.Code, action = issue.Action }) },
            database = new { observationCount = count, storageBytes = store.ReadStorageBytes(), integrity, integrityCheckedAt, schemaVersion = store.SchemaVersion, durableCounters = store.ReadCounters() },
            flows = new { total = flowStats.Total, snapshot = flowStats.Snapshot, etw = flowStats.Etw, both = flowStats.Both, bytesUnknown = flowStats.BytesUnknown, processNames = new { resolved = processNames.Resolved, unresolved = processNames.Unresolved }, byOrigin = store.ReadFlowOrigins() },
            coverage = new { total = coverage.Total, active = coverage.Active, abandoned = coverage.Abandoned },
            monitoringEnabled,
            delivery = new { pending = delivery.Pending, contractRejected = delivery.ContractRejected, queueOverflow = delivery.QueueOverflow, oldestPendingAt = delivery.OldestPendingAt, lastAcknowledgedAt = delivery.LastAcknowledgedAt, capability = capabilityStatus, runtime = SafeDeliveryRuntime(deliveryRuntime) },
            deliveryEnabled = store.DeliveryEnabled,
            ipc = new { reportChannel },
            // The service's own earlier failures. A report taken from a
            // service that is running again is exactly when someone asks why
            // the start before it did not.
            serviceFailures = SafeServiceFailures(Path.GetDirectoryName(store.DatabasePath)),
            installer = ReadInstallerState(),
            privacy = new { includesEndpoints = false, includesHostnames = false, includesProcessNames = false, includesCredentials = false, includesHubEndpoint = false, includesRawObservations = false, includesDatabase = false },
        }, new JsonSerializerOptions { WriteIndented = true });
    }

    /// The report written when the service cannot be asked.
    ///
    /// failureCode is why the caller could not reach it -- for the window,
    /// its own pipe timeout. That is not why the service is down, and until
    /// dataDirectory was passed it was the only failure a bundle carried: a
    /// migration that failed at step 6 of 8 was reported as "TimeoutException".
    public static string CreateFallback(string version, string failureCode, string? dataDirectory = null) => JsonSerializer.Serialize(new
    {
        schemaVersion = 1,
        generatedAt = DateTimeOffset.UtcNow,
        build = new { version, informationalVersion = InformationalVersion(), osVersion = Environment.OSVersion.VersionString, architecture = RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant() },
        service = new { reachable = false, failure = SafeCode(failureCode) },
        serviceFailures = SafeServiceFailures(dataDirectory),
        installer = ReadInstallerState(),
        privacy = new { includesEndpoints = false, includesHostnames = false, includesProcessNames = false, includesCredentials = false, includesHubEndpoint = false, includesRawObservations = false, includesDatabase = false },
    }, new JsonSerializerOptions { WriteIndented = true });

    /// The recorded failures, in the bundle's shape.
    ///
    /// Only fields ServiceFailure defines, which are all values the Agent
    /// chose -- a type name, an enum name, version and step numbers, a time.
    /// Nothing here is read from the machine, so nothing here can be a path
    /// or a host.
    private static object[] SafeServiceFailures(string? dataDirectory)
    {
        if (string.IsNullOrEmpty(dataDirectory)) return [];
        return ServiceFailure.Read(dataDirectory).Select(failure => (object)new
        {
            at = failure.At,
            exceptionType = SafeCode(failure.ExceptionType),
            storeFailure = failure.StoreFailure is null ? null : SafeCode(failure.StoreFailure),
            migration = failure.Migration is { } m
                ? new { fromVersion = m.FromVersion, toVersion = m.ToVersion, step = m.Step, steps = m.Steps }
                : null,
        }).ToArray();
    }

    /// How the recorded runs ended, counted by kind and by component.
    ///
    /// Reading the list and counting it are different jobs: the list is capped
    /// at 20 rows, so a count taken from it would silently describe only the
    /// part that fitted. This counts what the history holds.
    private static object SafeRunSummary(ObservationStore store)
    {
        try
        {
            var runs = store.ReadRunHistory(200);
            return new
            {
                service = CountEndings(runs, RunComponent.Service),
                ui = CountEndings(runs, RunComponent.Ui),
            };
        }
        catch (Exception) { return new { }; }
    }

    private static object CountEndings(IReadOnlyList<AgentRun> runs, RunComponent component)
    {
        var mine = runs.Where(run => run.Component == component).ToArray();
        return new
        {
            total = mine.Length,
            running = mine.Count(run => run.Ending == "running"),
            clean = mine.Count(run => run.Ending == "clean"),
            systemShutdown = mine.Count(run => run.Ending == "system-shutdown"),
            unexpected = mine.Count(run => run.Ending == "unexpected"),
            faulted = mine.Count(run => run.Ending == "faulted"),
        };
    }

    /// Component, timing and outcome. No message, no path, no destination --
    /// the same boundary the rest of this report keeps.
    private static object[] SafeRuns(ObservationStore store)
    {
        try
        {
            return store.ReadRunHistory(20).Select(run => (object)new
            {
                component = run.Component == RunComponent.Service ? "service" : "ui",
                version = run.Version,
                startedAt = run.StartedAt,
                lastSeenAt = run.HeartbeatAt,
                endedAt = run.EndedAt,
                ending = run.Ending,
                fault = run.Fault,
            }).ToArray();
        }
        catch (Exception) { return []; }
    }

    /// Why delivery is where it is: the state it is in, what failed last,
    /// what the Hub answered, and when it will try again.
    ///
    /// This existed and reached the window over IPC, but not the bundle. A Hub
    /// that answered 400 to every batch carrying one malformed observation
    /// stopped delivery for hours, and the bundle -- the thing a person sends
    /// when they cannot work out what is wrong -- showed a pending count and a
    /// capability that said "agreed". Finding the reason took reading the live
    /// database and the Hub's schema by hand. The four fields below would have
    /// said "contract-rejected, HTTP 400" on the first look.
    ///
    /// Nothing here names a destination: the state and the failure are from a
    /// fixed vocabulary, the status code is the Hub's, and the times are the
    /// Agent's own. The Hub URL is deliberately absent, as it is everywhere
    /// else in this report.
    private static object? SafeDeliveryRuntime(DeliveryRuntimeStatus? value) => value is null ? null : new
    {
        state = SafeCode(value.State),
        lastAttemptAt = value.LastAttemptAt,
        nextRetryAt = value.NextRetryAt,
        lastFailure = SafeCode(value.LastFailure),
        lastFailureAt = value.LastFailureAt,
        lastStatusCode = value.LastStatusCode,
    };

    private static object SafeCollector(CollectorSnapshot value) => new
    {
        value.State, value.Accepted, value.Persisted, value.QueueFullDrops, value.PersistenceFailures,
        value.LastObservedAt, value.LastPersistedAt, value.QueueCapacity, value.EtwSessionActive, value.EtwEventsSeen,
        value.EtwEventsIgnored, value.EtwConnectionAttempted, value.EtwConnectionAccepted,
        value.EtwConnectionDisconnected, value.EtwConnectionClosed,
        value.InterfaceUnresolved, value.InboundMulticastIgnored, value.EtwEventsLost, value.EtwEventsLostAtStart,
        collectorError = SafeCode(value.CollectorError), persistenceError = SafeCode(value.PersistenceError),
        value.NamesFromStartEvents, value.NamesFromCache, value.NamesFromLiveQueries, value.NamesNeverSeen, value.NamesNeverSeenAtStartup,
        value.NamesNeverSeenAfterStartup, value.NamesNeverSeenAfterStartProbeMiss, value.NamesNeverSeenWithoutStartEvent,
        value.NamesInvalidProcessId, value.NamesExpired, value.NamesPidReuseRejected, value.NamesDeferredPending,
        value.NamesDeferred, value.NamesRecoveredFromStop, value.NamesDeferredExpired, value.NamesDeferredOverflow,
        processNameSourceError = SafeCode(value.ProcessNameSourceError), value.HostnamesResolved, value.HostnamesUnavailable,
        value.DnsEventsSeen, hostnameSourceError = SafeCode(value.HostnameSourceError),
        // Counts, so nothing about the traffic itself. Left out of the first
        // version of the summing and therefore unmeasurable: the report is
        // where the compression has to be visible, or the next person has to
        // take it on trust.
        value.EventsFolded, value.ObservationsEmitted, value.CoalescerOverflows, value.CoalescerOpenFlows,
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
