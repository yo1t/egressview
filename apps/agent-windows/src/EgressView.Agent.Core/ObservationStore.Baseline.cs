namespace EgressView.Agent.Core;

/// What this machine's outbound traffic usually looks like, as far as it has
/// been measured (P3-192, P3-193 phase 1).
///
/// Counted in monitored hours, never in calendar days: a PC that sleeps most
/// of the week has a few hours of history, not seven days of silence, and
/// reading it as the second is how the fifteen-minute detector stayed in
/// "learning" for ever on one (2026-10-31, 12 windows in 7 days).
public sealed record OutboundBaselineSummary(
    double MonitoredHours,
    int HoursRecorded,
    int FullyMonitoredHours,
    DateTimeOffset? Since,
    ulong HourlyMedianBytesOut,
    ulong HourlyP99BytesOut,
    ulong LargestHourBytesOut,
    double? NamedShare,
    double? BytesShare,
    long PairsKnown);

/// The keys the baseline counts by, shared with the measurement scripts so
/// the Agent and the scripts can be checked against each other.
public static class OutboundBaselineKeys
{
    public const string UnknownApplication = "(unknown)";

    public static string Application(string? processName) =>
        string.IsNullOrWhiteSpace(processName) ? UnknownApplication : processName;

    /// The registrable domain of a host name, approximately: the last two
    /// labels, or three under a two-letter top-level domain whose second level
    /// is three letters or fewer (co.jp, com.au). No public suffix list -- the
    /// same rule as `scripts/p3-193-measure-new-pairs.js`, and the same on the
    /// Mac. Without a name, the address itself.
    public static string Destination(string? hostname, string address)
    {
        if (string.IsNullOrWhiteSpace(hostname)) return address.ToLowerInvariant();
        var labels = hostname.Trim().TrimEnd('.').ToLowerInvariant().Split('.');
        if (labels.Length <= 2) return string.Join('.', labels);
        var take = labels[^1].Length == 2 && labels[^2].Length <= 3 ? 3 : 2;
        return string.Join('.', labels[^take..]);
    }
}

public sealed partial class ObservationStore
{
    /// More pairs than this and the ones seen longest ago are forgotten first.
    public const int BaselinePairCapacity = 50_000;
    /// A completed hour is read this long after it ends, so the observations
    /// still on their way to the database are in it.
    public static readonly TimeSpan BaselineSettleDelay = TimeSpan.FromMinutes(2);
    /// An hour with this much monitoring counts as fully monitored.
    public const int FullyMonitoredSeconds = 3420;
    private const int BaselinePairDays = 35;

    /// Version 32: the tables each Agent keeps about its own machine.
    ///
    /// Derived from the history, so they follow it: the retention setting
    /// bounds them and deleting history deletes them. Bounded on their own
    /// as well -- hours by the retention, pair-days by 35 days, pairs by
    /// <see cref="BaselinePairCapacity"/>.
    private const string Version32Schema = """
        CREATE TABLE IF NOT EXISTS baseline_hours(
          hour_start TEXT PRIMARY KEY,
          monitored_seconds INTEGER NOT NULL,
          bytes_out INTEGER NOT NULL,
          observations INTEGER NOT NULL,
          observations_with_bytes INTEGER NOT NULL,
          named_observations INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS baseline_pair_days(
          day TEXT NOT NULL,
          application TEXT NOT NULL,
          destination TEXT NOT NULL,
          bytes_out INTEGER NOT NULL,
          PRIMARY KEY(day,application,destination)
        ) WITHOUT ROWID;
        CREATE TABLE IF NOT EXISTS baseline_pairs(
          application TEXT NOT NULL,
          destination TEXT NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          PRIMARY KEY(application,destination)
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS baseline_pairs_last_seen ON baseline_pairs(last_seen);
        CREATE TABLE IF NOT EXISTS baseline_state(
          id INTEGER PRIMARY KEY CHECK(id=1),
          captured_through TEXT
        );
        INSERT OR IGNORE INTO baseline_state(id) VALUES(1);
        """;

    /// No backup: four new tables, empty, in one transaction.
    private void MigrateVersion31To32()
    {
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version32Schema + " UPDATE schema_version SET version=32 WHERE version=31; COMMIT;");
        }
        catch { TryRollback(); throw; }
    }

    private void ValidateBaselineSchema()
    {
        if (ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('baseline_hours','baseline_pair_days','baseline_pairs','baseline_state')") != 4
            || ScalarInt64("SELECT COUNT(*) FROM baseline_state WHERE id=1") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing the outbound baseline.");
    }

    /// Writes the completed hours not yet written, oldest first, at most
    /// <paramref name="maxHours"/> per call.
    ///
    /// Idempotent: where it got to is kept in the same transaction as what it
    /// wrote, so a restart neither skips an hour nor counts one twice. The
    /// first run reaches back as far as the raw history goes, so a machine
    /// starts with what it already has rather than from nothing.
    ///
    /// An hour with no monitoring and no observations is not written. A
    /// missing hour means "not watched", which is not the same as "quiet",
    /// and the summary must not average the two together.
    /// <returns>How many hours were read.</returns>
    public int CaptureBaselineHours(DateTimeOffset now, int maxHours = 24)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            var settledEnd = FloorHour(now.ToUniversalTime() - BaselineSettleDelay);
            var earliest = FloorHour(now.ToUniversalTime().AddDays(-DefaultRawRetentionDays));
            var throughText = NullableScalarText("SELECT captured_through FROM baseline_state WHERE id=1");
            var hour = throughText is null ? earliest : DateTimeOffset.Parse(throughText);
            if (hour < earliest) hour = earliest;
            var read = 0;
            while (hour.AddHours(1) <= settledEnd && read < maxHours)
            {
                CaptureBaselineHourLocked(hour);
                hour = hour.AddHours(1);
                read++;
            }
            if (read > 0) ForgetBaselinePairsOverCapacityLocked();
            return read;
        }
    }

    private void CaptureBaselineHourLocked(DateTimeOffset hour)
    {
        var end = hour.AddHours(1);
        var monitored = MonitoredSecondsLocked(hour, end);
        // The name on the row, or else the one its connection learned: a name
        // arrives with one event and the connection keeps it, but the rows
        // before it stay nameless. Measured on 2026-10-31, rows alone named
        // 39.1% of what went outside this network, rows with their connection
        // 62.6%. Most of the rest has no name to find -- DNS servers
        // themselves (port 53) and peer-to-peer STUN (3478).
        CheckOperation(WinSqlite.Prepare(db, "SELECT o.remote_address,MAX(COALESCE(o.remote_hostname,f.remote_hostname)),COALESCE(o.process_name,''),COUNT(*),COUNT(o.bytes_sent)," +
            "COUNT(COALESCE(o.remote_hostname,f.remote_hostname)),COALESCE(SUM(o.bytes_sent),0) FROM observations o LEFT JOIN flows f ON f.rowid=o.flow_id " +
            $"WHERE o.observed_at >= {hour.UtcTicks} AND o.observed_at < {end.UtcTicks} GROUP BY 1,3", -1, out var statement, 0));
        var pairs = new Dictionary<(string Application, string Destination), ulong>();
        long observations = 0, withBytes = 0, named = 0;
        ulong bytesOut = 0;
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
            {
                var address = Text(statement, 0);
                // The same "outside this network" as the fifteen-minute
                // windows, so the two never disagree about what left.
                if (PrivateAddress.StaysOnNetwork(address)) continue;
                var key = (OutboundBaselineKeys.Application(Text(statement, 2)),
                    OutboundBaselineKeys.Destination(NullableTextValue(statement, 1), address));
                var sent = (ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 6));
                pairs[key] = pairs.GetValueOrDefault(key) + sent;
                observations += WinSqlite.ColumnInt64(statement, 3);
                withBytes += WinSqlite.ColumnInt64(statement, 4);
                named += WinSqlite.ColumnInt64(statement, 5);
                bytesOut += sent;
            }
        }
        finally { WinSqlite.Finalize(statement); }

        Execute("BEGIN IMMEDIATE");
        try
        {
            if (monitored > 0 || observations > 0)
            {
                Execute("INSERT OR REPLACE INTO baseline_hours(hour_start,monitored_seconds,bytes_out,observations,observations_with_bytes,named_observations) " +
                    $"VALUES('{hour:O}',{monitored},{bytesOut},{observations},{withBytes},{named})");
                var day = new DateTimeOffset(hour.Year, hour.Month, hour.Day, 0, 0, 0, TimeSpan.Zero);
                const string pairSql = "INSERT INTO baseline_pairs(application,destination,first_seen,last_seen) VALUES(?,?,?,?) " +
                    "ON CONFLICT(application,destination) DO UPDATE SET first_seen=MIN(first_seen,excluded.first_seen),last_seen=MAX(last_seen,excluded.last_seen)";
                const string daySql = "INSERT INTO baseline_pair_days(day,application,destination,bytes_out) VALUES(?,?,?,?) " +
                    "ON CONFLICT(day,application,destination) DO UPDATE SET bytes_out=bytes_out+excluded.bytes_out";
                CheckOperation(WinSqlite.Prepare(db, pairSql, -1, out var pairStatement, 0));
                CheckOperation(WinSqlite.Prepare(db, daySql, -1, out var dayStatement, 0));
                try
                {
                    foreach (var ((application, destination), sent) in pairs)
                    {
                        Bind(pairStatement, 1, application); Bind(pairStatement, 2, destination);
                        Bind(pairStatement, 3, hour.ToString("O")); Bind(pairStatement, 4, hour.ToString("O"));
                        CheckDone(WinSqlite.Step(pairStatement)); Check(WinSqlite.Reset(pairStatement)); Check(WinSqlite.ClearBindings(pairStatement));
                        if (sent == 0) continue;
                        Bind(dayStatement, 1, day.ToString("O")); Bind(dayStatement, 2, application); Bind(dayStatement, 3, destination);
                        BindNullable(dayStatement, 4, (long)Math.Min(sent, long.MaxValue));
                        CheckDone(WinSqlite.Step(dayStatement)); Check(WinSqlite.Reset(dayStatement)); Check(WinSqlite.ClearBindings(dayStatement));
                    }
                }
                finally { WinSqlite.Finalize(pairStatement); WinSqlite.Finalize(dayStatement); }
            }
            Execute($"UPDATE baseline_state SET captured_through='{end:O}' WHERE id=1");
            Execute("COMMIT");
        }
        catch { TryRollback(); throw; }
    }

    /// Covered seconds in the hour, with sleep taken out.
    private long MonitoredSecondsLocked(DateTimeOffset from, DateTimeOffset to)
    {
        var covered = ReadCoveredIntervals(from, to);
        if (covered.Count == 0) return 0;
        var sleeps = ReadSleepPeriodsLocked(from, to);
        double seconds = 0;
        foreach (var (start, end) in covered)
        {
            seconds += (end - start).TotalSeconds;
            foreach (var sleep in sleeps)
            {
                var overlapStart = sleep.Start > start ? sleep.Start : start;
                var overlapEnd = sleep.End < end ? sleep.End : end;
                if (overlapEnd > overlapStart) seconds -= (overlapEnd - overlapStart).TotalSeconds;
            }
        }
        return (long)Math.Clamp(Math.Round(seconds), 0, (to - from).TotalSeconds);
    }

    private void ForgetBaselinePairsOverCapacityLocked()
    {
        var excess = ScalarInt64("SELECT COUNT(*) FROM baseline_pairs") - BaselinePairCapacity;
        if (excess <= 0) return;
        Execute("DELETE FROM baseline_pairs WHERE (application,destination) IN " +
            $"(SELECT application,destination FROM baseline_pairs ORDER BY last_seen LIMIT {excess})");
    }

    /// Keeps the baseline within the retention the person chose, as the rest
    /// of the history is kept. A pair first seen before the cutoff is kept
    /// with its first sighting moved to the cutoff: that it existed then is
    /// within what may be kept; when it began is not.
    private void PruneBaselineLocked(DateTimeOffset cutoff)
    {
        var value = cutoff.ToUniversalTime().ToString("O");
        var pairDayCutoff = Max(cutoff, DateTimeOffset.UtcNow.AddDays(-BaselinePairDays)).ToString("O");
        Execute($"DELETE FROM baseline_hours WHERE hour_start<'{value}'");
        Execute($"DELETE FROM baseline_pair_days WHERE day<'{pairDayCutoff}'");
        Execute($"DELETE FROM baseline_pairs WHERE last_seen<'{value}'");
        Execute($"UPDATE baseline_pairs SET first_seen='{value}' WHERE first_seen<'{value}'");

        static DateTimeOffset Max(DateTimeOffset a, DateTimeOffset b) => a > b ? a : b;
    }

    /// Deleting history deletes what was derived from it. Everything goes,
    /// pairs included, whether or not they were also seen after the cutoff:
    /// a pair's memory is made of the deleted time too, and keeping it would
    /// keep part of what was asked to be deleted.
    private void DeleteBaselineLocked(DateTimeOffset? before)
    {
        if (before is not { } cutoff)
        {
            Execute("DELETE FROM baseline_hours; DELETE FROM baseline_pair_days; DELETE FROM baseline_pairs;");
            // Nothing left to read back to, so the next hour starts afresh.
            Execute($"UPDATE baseline_state SET captured_through='{FloorHour(DateTimeOffset.UtcNow):O}' WHERE id=1");
            return;
        }
        var value = cutoff.ToUniversalTime().ToString("O");
        Execute($"DELETE FROM baseline_hours WHERE hour_start<'{value}'");
        Execute($"DELETE FROM baseline_pair_days WHERE day<'{value}'");
        Execute($"DELETE FROM baseline_pairs WHERE first_seen<'{value}'");
    }

    public OutboundBaselineSummary ReadOutboundBaselineSummary()
    {
        lock (gate) return ReadOutboundBaselineSummaryLocked();
    }

    private OutboundBaselineSummary ReadOutboundBaselineSummaryLocked()
    {
        CheckOperation(WinSqlite.Prepare(db, "SELECT hour_start,monitored_seconds,bytes_out,observations,observations_with_bytes,named_observations FROM baseline_hours ORDER BY hour_start",
            -1, out var statement, 0));
        long monitored = 0, observations = 0, withBytes = 0, named = 0;
        var hours = 0;
        DateTimeOffset? since = null;
        var full = new List<ulong>();
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
            {
                since ??= DateTimeOffset.Parse(Text(statement, 0));
                var seconds = WinSqlite.ColumnInt64(statement, 1);
                monitored += seconds;
                observations += WinSqlite.ColumnInt64(statement, 3);
                withBytes += WinSqlite.ColumnInt64(statement, 4);
                named += WinSqlite.ColumnInt64(statement, 5);
                hours++;
                if (seconds >= FullyMonitoredSeconds) full.Add((ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 2)));
            }
        }
        finally { WinSqlite.Finalize(statement); }
        full.Sort();
        ulong Percentile(double p) => full.Count == 0 ? 0 : full[Math.Min(full.Count - 1, (int)Math.Floor(p * full.Count))];
        return new(monitored / 3600.0, hours, full.Count, since, Percentile(0.5), Percentile(0.99),
            full.Count == 0 ? 0 : full[^1],
            observations == 0 ? null : (double)named / observations,
            observations == 0 ? null : (double)withBytes / observations,
            ScalarInt64("SELECT COUNT(*) FROM baseline_pairs"));
    }

    private static DateTimeOffset FloorHour(DateTimeOffset value)
    {
        var utc = value.ToUniversalTime();
        return new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
    }
}
