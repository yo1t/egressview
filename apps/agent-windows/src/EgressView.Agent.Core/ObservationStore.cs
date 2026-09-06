using System.Runtime.InteropServices;
using System.Net;

namespace EgressView.Agent.Core;

public sealed partial class ObservationStore : IDisposable
{
    private const int CurrentSchemaVersion = 8;
    private const string Version1Schema = """
        CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
        INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
        CREATE TABLE IF NOT EXISTS observations(
          id INTEGER PRIMARY KEY,
          observed_at TEXT NOT NULL,
          process_id INTEGER NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('TCP','UDP')),
          local_address TEXT NOT NULL,
          local_port INTEGER NOT NULL,
          remote_address TEXT NOT NULL,
          remote_port INTEGER NOT NULL,
          bytes_sent INTEGER,
          bytes_received INTEGER,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          interface_id TEXT,
          source TEXT NOT NULL CHECK(source IN ('etw','snapshot'))
        );
        CREATE INDEX IF NOT EXISTS observations_observed_at ON observations(observed_at);
        CREATE TABLE IF NOT EXISTS collector_counters(
          name TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        """;
    private const string Version2Schema = """
        CREATE TABLE IF NOT EXISTS flows(
          flow_key TEXT PRIMARY KEY,
          protocol TEXT NOT NULL,
          local_address TEXT NOT NULL,
          local_port INTEGER NOT NULL,
          remote_address TEXT NOT NULL,
          remote_port INTEGER NOT NULL,
          process_id INTEGER NOT NULL,
          first_seen TEXT NOT NULL,
          last_seen TEXT NOT NULL,
          origin TEXT NOT NULL CHECK(origin IN ('snapshot','etw','both')),
          bytes_sent INTEGER,
          bytes_received INTEGER,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          interface_id TEXT
        );
        CREATE INDEX IF NOT EXISTS flows_last_seen ON flows(last_seen);
        DELETE FROM flows WHERE origin='snapshot' AND protocol='TCP' AND remote_port=0;
        CREATE TABLE IF NOT EXISTS coverage_sessions(
          id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,
          ended_at TEXT,
          snapshot_count INTEGER NOT NULL
        );
        """;
    private const string Version3Schema = """
        CREATE TABLE IF NOT EXISTS hourly_summary(
          bucket_start TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('TCP','UDP')),
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          observation_count INTEGER NOT NULL,
          bytes_sent INTEGER NOT NULL,
          bytes_received INTEGER NOT NULL,
          bytes_unknown INTEGER NOT NULL,
          PRIMARY KEY(bucket_start,protocol,layer)
        );
        """;
    private const string Version4Schema = """
        ALTER TABLE observations ADD COLUMN process_name TEXT;
        ALTER TABLE flows ADD COLUMN process_name TEXT;
        """;
    private const string Version5Schema = """
        CREATE TABLE IF NOT EXISTS delivery_queue(
          delivery_id TEXT PRIMARY KEY,
          stable_key TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK(protocol IN ('tcp','udp')),
          local_address TEXT NOT NULL,
          local_port INTEGER NOT NULL,
          remote_address TEXT NOT NULL,
          remote_port INTEGER NOT NULL,
          process_id INTEGER NOT NULL,
          process_name TEXT NOT NULL,
          first_observed_at TEXT NOT NULL,
          last_observed_at TEXT NOT NULL,
          bytes_in INTEGER,
          bytes_out INTEGER,
          queued_at TEXT NOT NULL,
          batch_id TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS delivery_queue_pending_flow ON delivery_queue(stable_key) WHERE batch_id IS NULL;
        CREATE INDEX IF NOT EXISTS delivery_queue_batch ON delivery_queue(batch_id,queued_at);
        CREATE TABLE IF NOT EXISTS delivery_state(
          id INTEGER PRIMARY KEY CHECK(id=1),
          contract_rejected INTEGER NOT NULL DEFAULT 0,
          queue_overflow INTEGER NOT NULL DEFAULT 0,
          last_acknowledged_at TEXT
        );
        INSERT OR IGNORE INTO delivery_state(id) VALUES(1);
        """;
    private const string Version6Schema = """
        ALTER TABLE delivery_state ADD COLUMN delivery_enabled INTEGER NOT NULL DEFAULT 0 CHECK(delivery_enabled IN (0,1));
        """;
    private const string Version7Schema = """
        CREATE TABLE IF NOT EXISTS geo_locations(
          ip TEXT PRIMARY KEY,
          latitude REAL NOT NULL,
          longitude REAL NOT NULL,
          country_code TEXT,
          city TEXT
        );
        CREATE TABLE IF NOT EXISTS geo_cache_state(
          id INTEGER PRIMARY KEY CHECK(id=1),
          etag TEXT,
          fetched_at TEXT
        );
        INSERT OR IGNORE INTO geo_cache_state(id) VALUES(1);
        """;
    private const string Version8Schema = """
        CREATE TABLE IF NOT EXISTS threat_indicators(
          kind TEXT NOT NULL CHECK(kind IN ('ip','domain','cidr')),
          value TEXT NOT NULL,
          source TEXT,
          tag TEXT,
          confidence TEXT NOT NULL CHECK(confidence IN ('high','low')),
          PRIMARY KEY(kind,value)
        );
        CREATE TABLE IF NOT EXISTS threat_cache_state(
          id INTEGER PRIMARY KEY CHECK(id=1),
          availability TEXT NOT NULL DEFAULT 'not_fetched' CHECK(availability IN ('not_fetched','available','unavailable')),
          etag TEXT,
          fetched_at TEXT
        );
        INSERT OR IGNORE INTO threat_cache_state(id) VALUES(1);
        """;

    private readonly object gate = new();
    private nint db;
    private bool disposed;
    private readonly string path;

    public long SchemaVersion { get { lock (gate) return ScalarInt64("SELECT version FROM schema_version"); } }

    public ObservationStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        this.path = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(this.path)!);
        Check(WinSqlite.Open(this.path, out db, WinSqlite.OpenReadWrite | WinSqlite.OpenCreate | WinSqlite.OpenFullMutex, 0));
        try { Initialize(); }
        catch { if (db != 0) WinSqlite.Close(db); db = 0; throw; }
    }

    private void Initialize()
    {
        Execute("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
        var hasVersion = ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_version'") == 1;
        if (!hasVersion)
        {
            var existingTables = ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
            if (existingTables != 0)
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database has tables but no schema version; refusing to treat existing data as a new database.");
            Execute($"BEGIN IMMEDIATE; {Version1Schema} {Version2Schema} {Version3Schema} {Version4Schema} {Version5Schema} {Version6Schema} {Version7Schema} {Version8Schema} UPDATE schema_version SET version={CurrentSchemaVersion}; COMMIT;");
            return;
        }

        EnsureIntegrity();
        var version = ScalarInt64("SELECT version FROM schema_version");
        if (version > CurrentSchemaVersion)
            throw new ObservationStoreException(StoreFailureKind.SchemaTooNew, $"Database schema {version} is newer than supported schema {CurrentSchemaVersion}.");
        if (version < 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, $"Database schema version {version} is invalid.");
        if (version == 1) { MigrateVersion1To2(); version = 2; }
        if (version == 2) { MigrateVersion2To3(); version = 3; }
        if (version == 3) { MigrateVersion3To4(); version = 4; }
        if (version == 4) { MigrateVersion4To5(); version = 5; }
        if (version == 5) { MigrateVersion5To6(); version = 6; }
        if (version == 6) { MigrateVersion6To7(); version = 7; }
        if (version == 7) MigrateVersion7To8();
        ValidateSchema();
    }

    private void MigrateVersion1To2()
    {
        var backup = $"{path}.pre-v2.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try
        {
            Execute($"BEGIN IMMEDIATE; {Version2Schema} UPDATE schema_version SET version=2 WHERE version=1; COMMIT;");
        }
        catch
        {
            TryRollback();
            throw;
        }
    }

    private void MigrateVersion2To3()
    {
        var backup = $"{path}.pre-v3.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version3Schema} UPDATE schema_version SET version=3 WHERE version=2; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion3To4()
    {
        var backup = $"{path}.pre-v4.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version4Schema} UPDATE schema_version SET version=4 WHERE version=3; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion4To5()
    {
        var backup = $"{path}.pre-v5.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version5Schema} UPDATE schema_version SET version=5 WHERE version=4; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion5To6()
    {
        var backup = $"{path}.pre-v6.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version6Schema} UPDATE schema_version SET version=6 WHERE version=5; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion6To7()
    {
        var backup = $"{path}.pre-v7.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version7Schema} UPDATE schema_version SET version=7 WHERE version=6; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion7To8()
    {
        var backup = $"{path}.pre-v8.bak";
        if (!File.Exists(backup)) Execute($"VACUUM INTO '{Sql(backup)}'");
        try { Execute($"BEGIN IMMEDIATE; {Version8Schema} UPDATE schema_version SET version=8 WHERE version=7; COMMIT;"); }
        catch { TryRollback(); throw; }
    }

    private void EnsureIntegrity()
    {
        var integrity = ScalarText("PRAGMA integrity_check");
        if (!string.Equals(integrity, "ok", StringComparison.Ordinal))
            throw new ObservationStoreException(StoreFailureKind.Corrupt, $"Database integrity check failed: {integrity}");
    }

    private void ValidateSchema()
    {
        if (ScalarInt64("SELECT COUNT(*) FROM schema_version") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database must contain exactly one schema version row.");
        var tables = ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('schema_version','observations','collector_counters','flows','coverage_sessions','hourly_summary','delivery_queue','delivery_state','geo_locations','geo_cache_state','threat_indicators','threat_cache_state')");
        if (tables != 12)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is incomplete; refusing to recreate missing customer data tables.");
        var processNameColumns = ScalarInt64("SELECT (SELECT COUNT(*) FROM pragma_table_info('observations') WHERE name='process_name') + (SELECT COUNT(*) FROM pragma_table_info('flows') WHERE name='process_name')");
        if (processNameColumns != 2)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing process identity columns.");
        if (ScalarInt64("SELECT COUNT(*) FROM pragma_table_info('delivery_state') WHERE name='delivery_enabled'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing the delivery opt-in state.");
    }

    public void WriteBatch(IReadOnlyList<NetworkObservation> observations, bool queueForDelivery = false)
    {
        if (observations.Count == 0) return;
        lock (gate)
        {
            ThrowIfDisposed();
            Execute("BEGIN IMMEDIATE");
            try
            {
                const string sql = """
                    INSERT INTO observations(observed_at,process_id,protocol,local_address,local_port,
                      remote_address,remote_port,bytes_sent,bytes_received,layer,interface_id,source,process_name)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
                    """;
                const string flowSql = """
                    INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,
                      process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,process_name)
                    VALUES(?,?,?,?,?,?,?,?,?,'etw',?,?,?,?,?)
                    ON CONFLICT(flow_key) DO UPDATE SET
                      last_seen=excluded.last_seen,
                      origin=CASE WHEN flows.origin='snapshot' THEN 'both' ELSE flows.origin END,
                      bytes_sent=CASE WHEN flows.bytes_sent IS NULL THEN excluded.bytes_sent ELSE flows.bytes_sent+excluded.bytes_sent END,
                      bytes_received=CASE WHEN flows.bytes_received IS NULL THEN excluded.bytes_received ELSE flows.bytes_received+excluded.bytes_received END,
                      layer=excluded.layer,
                      interface_id=COALESCE(excluded.interface_id,flows.interface_id),
                      process_name=COALESCE(excluded.process_name,flows.process_name)
                    """;
                Check(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                Check(WinSqlite.Prepare(db, flowSql, -1, out var flowStatement, 0));
                var summaries = new Dictionary<(string Bucket, string Protocol, string Layer), (long Count, long Sent, long Received, long Unknown)>();
                try
                {
                    foreach (var item in observations)
                    {
                        Bind(statement, 1, item.ObservedAt.ToUniversalTime().ToString("O"));
                        Check(WinSqlite.BindInt64(statement, 2, item.ProcessId));
                        Bind(statement, 3, item.Protocol);
                        Bind(statement, 4, item.LocalAddress);
                        Check(WinSqlite.BindInt64(statement, 5, item.LocalPort));
                        Bind(statement, 6, item.RemoteAddress);
                        Check(WinSqlite.BindInt64(statement, 7, item.RemotePort));
                        BindNullable(statement, 8, item.BytesSent);
                        BindNullable(statement, 9, item.BytesReceived);
                        Bind(statement, 10, item.Layer == ObservationLayer.Logical ? "logical" : "vpn_transport");
                        BindNullable(statement, 11, item.InterfaceId);
                        Bind(statement, 12, item.Source);
                        BindNullable(statement, 13, item.ProcessName);
                        CheckDone(WinSqlite.Step(statement));
                        Check(WinSqlite.Reset(statement));
                        Check(WinSqlite.ClearBindings(statement));
                        Bind(flowStatement, 1, StartupSnapshot.FlowKey(item.Protocol, item.LocalAddress, item.LocalPort, item.RemoteAddress, item.RemotePort, item.ProcessId));
                        Bind(flowStatement, 2, item.Protocol); Bind(flowStatement, 3, item.LocalAddress);
                        Check(WinSqlite.BindInt64(flowStatement, 4, item.LocalPort)); Bind(flowStatement, 5, item.RemoteAddress);
                        Check(WinSqlite.BindInt64(flowStatement, 6, item.RemotePort)); Check(WinSqlite.BindInt64(flowStatement, 7, item.ProcessId));
                        Bind(flowStatement, 8, item.ObservedAt.ToUniversalTime().ToString("O")); Bind(flowStatement, 9, item.ObservedAt.ToUniversalTime().ToString("O"));
                        BindNullable(flowStatement, 10, item.BytesSent); BindNullable(flowStatement, 11, item.BytesReceived);
                        Bind(flowStatement, 12, item.Layer == ObservationLayer.Logical ? "logical" : "vpn_transport"); BindNullable(flowStatement, 13, item.InterfaceId);
                        BindNullable(flowStatement, 14, item.ProcessName);
                        CheckDone(WinSqlite.Step(flowStatement)); Check(WinSqlite.Reset(flowStatement)); Check(WinSqlite.ClearBindings(flowStatement));
                        var observed = item.ObservedAt.ToUniversalTime();
                        var bucket = new DateTimeOffset(observed.Year, observed.Month, observed.Day, observed.Hour, 0, 0, TimeSpan.Zero).ToString("O");
                        var layer = item.Layer == ObservationLayer.Logical ? "logical" : "vpn_transport";
                        var key = (bucket, item.Protocol, layer);
                        var current = summaries.GetValueOrDefault(key);
                        summaries[key] = (current.Count + 1, current.Sent + (item.BytesSent ?? 0),
                            current.Received + (item.BytesReceived ?? 0), current.Unknown + (item.BytesSent is null || item.BytesReceived is null ? 1 : 0));
                    }
                }
                finally { WinSqlite.Finalize(statement); WinSqlite.Finalize(flowStatement); }
                foreach (var (key, value) in summaries)
                    Execute($"INSERT INTO hourly_summary(bucket_start,protocol,layer,observation_count,bytes_sent,bytes_received,bytes_unknown) VALUES('{key.Bucket}','{key.Protocol}','{key.Layer}',{value.Count},{value.Sent},{value.Received},{value.Unknown}) ON CONFLICT(bucket_start,protocol,layer) DO UPDATE SET observation_count=observation_count+excluded.observation_count,bytes_sent=bytes_sent+excluded.bytes_sent,bytes_received=bytes_received+excluded.bytes_received,bytes_unknown=bytes_unknown+excluded.bytes_unknown");
                if (queueForDelivery) QueueForDeliveryWithinTransaction(observations, DateTimeOffset.UtcNow, 10_000);
                Execute("COMMIT");
            }
            catch
            {
                TryRollback();
                throw;
            }
        }
    }

    public long BeginCoverage(IReadOnlyList<StartupFlow> snapshot, DateTimeOffset startedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                foreach (var flow in snapshot)
                {
                    var key = StartupSnapshot.FlowKey(flow.Protocol, flow.LocalAddress, flow.LocalPort, flow.RemoteAddress, flow.RemotePort, flow.ProcessId).Replace("'", "''", StringComparison.Ordinal);
                    var processName = flow.ProcessName is null ? "NULL" : $"'{Sql(flow.ProcessName)}'";
                    Execute($"INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,process_name) VALUES('{key}','{flow.Protocol}','{flow.LocalAddress}',{flow.LocalPort},'{flow.RemoteAddress}',{flow.RemotePort},{flow.ProcessId},'{startedAt:O}','{startedAt:O}','snapshot',NULL,NULL,'logical',NULL,{processName}) ON CONFLICT(flow_key) DO NOTHING");
                }
                Execute($"INSERT INTO coverage_sessions(started_at,snapshot_count) VALUES('{startedAt:O}',{snapshot.Count})");
                var id = ScalarInt64("SELECT last_insert_rowid()");
                Execute("COMMIT");
                return id;
            }
            catch { TryRollback(); throw; }
        }
    }

    public void EndCoverage(long id, DateTimeOffset endedAt)
    {
        lock (gate) Execute($"UPDATE coverage_sessions SET ended_at='{endedAt:O}' WHERE id={id} AND ended_at IS NULL");
    }

    public IReadOnlyDictionary<string, long> ReadFlowOrigins()
    {
        lock (gate)
        {
            var result = new Dictionary<string, long>(StringComparer.Ordinal);
            Check(WinSqlite.Prepare(db, "SELECT origin,COUNT(*) FROM flows GROUP BY origin", -1, out var statement, 0));
            try { while (WinSqlite.Step(statement) == WinSqlite.Row) result[Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 0)) ?? "unknown"] = WinSqlite.ColumnInt64(statement, 1); }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    public (long Total, long Active, long Abandoned) ReadCoverage()
    {
        lock (gate) return (
            ScalarInt64("SELECT COUNT(*) FROM coverage_sessions"),
            ScalarInt64("SELECT COUNT(*) FROM coverage_sessions WHERE ended_at IS NULL AND id=(SELECT MAX(id) FROM coverage_sessions)"),
            ScalarInt64("SELECT COUNT(*) FROM coverage_sessions WHERE ended_at IS NULL AND id < (SELECT COALESCE(MAX(id),0) FROM coverage_sessions)"));
    }

    public (long Total, long Snapshot, long Etw, long Both, long BytesUnknown) ReadFlowStats()
    {
        lock (gate) return (
            ScalarInt64("SELECT COUNT(*) FROM flows"),
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE origin='snapshot'"),
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE origin='etw'"),
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE origin='both'"),
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE bytes_sent IS NULL OR bytes_received IS NULL"));
    }

    public (long Resolved, long Unresolved) ReadProcessNameStats()
    {
        lock (gate) return (
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE process_name IS NOT NULL"),
            ScalarInt64("SELECT COUNT(*) FROM flows WHERE process_name IS NULL"));
    }

    public void AddCounter(string name, long amount)
    {
        lock (gate)
        {
            var safeName = name.Replace("'", "''", StringComparison.Ordinal);
            Execute($"INSERT INTO collector_counters(name,value) VALUES('{safeName}',{amount}) " +
                    "ON CONFLICT(name) DO UPDATE SET value=value+excluded.value");
        }
    }

    public (long Count, string Integrity) Inspect()
    {
        lock (gate)
        {
            var count = ScalarInt64("SELECT COUNT(*) FROM observations");
            var integrity = ScalarText("PRAGMA integrity_check");
            return (count, integrity);
        }
    }

    public IReadOnlyDictionary<string, long> ReadCounters()
    {
        lock (gate)
        {
            var result = new Dictionary<string, long>(StringComparer.Ordinal);
            Check(WinSqlite.Prepare(db, "SELECT name,value FROM collector_counters ORDER BY name", -1, out var statement, 0));
            try
            {
                while (true)
                {
                    var code = WinSqlite.Step(statement);
                    if (code == WinSqlite.Done) break;
                    CheckRow(code);
                    var name = Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 0)) ?? "unknown";
                    result[name] = WinSqlite.ColumnInt64(statement, 1);
                }
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    private long ScalarInt64(string sql)
    {
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try { CheckQueryRow(WinSqlite.Step(statement)); return WinSqlite.ColumnInt64(statement, 0); }
        finally { WinSqlite.Finalize(statement); }
    }

    public IReadOnlyList<HourlySummary> ReadHourlySummary(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate)
        {
            var utc = from.ToUniversalTime();
            var firstBucket = new DateTimeOffset(utc.Year, utc.Month, utc.Day, utc.Hour, 0, 0, TimeSpan.Zero);
            var sql = $"SELECT bucket_start,protocol,layer,observation_count,bytes_sent,bytes_received,bytes_unknown FROM hourly_summary WHERE bucket_start>='{firstBucket:O}' AND bucket_start<'{to.ToUniversalTime():O}' ORDER BY bucket_start,protocol,layer";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<HourlySummary>();
            try
            {
                while (true)
                {
                    var code = WinSqlite.Step(statement);
                    if (code == WinSqlite.Done) break;
                    CheckQueryRow(code);
                    var bucket = DateTimeOffset.Parse(Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 0))!);
                    var protocol = Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 1))!;
                    var layer = Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 2)) == "logical" ? ObservationLayer.Logical : ObservationLayer.VpnTransport;
                    result.Add(new HourlySummary(bucket, protocol, layer, WinSqlite.ColumnInt64(statement, 3),
                        WinSqlite.ColumnInt64(statement, 4), WinSqlite.ColumnInt64(statement, 5), WinSqlite.ColumnInt64(statement, 6)));
                }
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    public IReadOnlyList<RecentFlow> ReadRecentFlows(int limit, int offset = 0)
    {
        if (limit is not (50 or 100 or 200 or 500)) throw new ArgumentOutOfRangeException(nameof(limit));
        if (offset is < 0 or > 1_000_000) throw new ArgumentOutOfRangeException(nameof(offset));
        lock (gate)
        {
            const string columns = "first_seen,last_seen,protocol,local_address,local_port,remote_address,remote_port,process_id,process_name,bytes_sent,bytes_received,layer,interface_id,origin";
            var sql = $"SELECT {columns} FROM flows ORDER BY last_seen DESC,flow_key LIMIT {limit} OFFSET {offset}";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<RecentFlow>();
            try
            {
                while (true)
                {
                    var code = WinSqlite.Step(statement);
                    if (code == WinSqlite.Done) break;
                    CheckQueryRow(code);
                    result.Add(new RecentFlow(
                        DateTimeOffset.Parse(Text(statement, 0)), DateTimeOffset.Parse(Text(statement, 1)),
                        Text(statement, 2), Text(statement, 3), (int)WinSqlite.ColumnInt64(statement, 4),
                        Text(statement, 5), (int)WinSqlite.ColumnInt64(statement, 6), (int)WinSqlite.ColumnInt64(statement, 7),
                        NullableTextValue(statement, 8), NullableInt64(statement, 9), NullableInt64(statement, 10),
                        Text(statement, 11) == "vpn_transport" ? ObservationLayer.VpnTransport : ObservationLayer.Logical,
                        NullableTextValue(statement, 12), Text(statement, 13)));
                }
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    public (string? ETag, DateTimeOffset? FetchedAt) ReadGeoCacheState()
    {
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, "SELECT etag,fetched_at FROM geo_cache_state WHERE id=1", -1, out var statement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(statement));
                var etag = NullableTextValue(statement, 0);
                var fetched = NullableTextValue(statement, 1);
                return (etag, fetched is null ? null : DateTimeOffset.Parse(fetched));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    public void ReplaceGeoLocations(IReadOnlyList<GeoLocation> locations, string? etag, DateTimeOffset fetchedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                Execute("DELETE FROM geo_locations");
                const string sql = "INSERT INTO geo_locations(ip,latitude,longitude,country_code,city) VALUES(?,?,?,?,?)";
                CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                try
                {
                    foreach (var location in locations)
                    {
                        Bind(statement, 1, location.Ip);
                        Check(WinSqlite.BindDouble(statement, 2, location.Latitude));
                        Check(WinSqlite.BindDouble(statement, 3, location.Longitude));
                        BindNullable(statement, 4, location.CountryCode);
                        BindNullable(statement, 5, location.City);
                        CheckDone(WinSqlite.Step(statement));
                        Check(WinSqlite.Reset(statement));
                        Check(WinSqlite.ClearBindings(statement));
                    }
                }
                finally { WinSqlite.Finalize(statement); }
                Execute($"UPDATE geo_cache_state SET etag={(etag is null ? "NULL" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}' WHERE id=1");
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public void MarkGeoCacheFetched(string? etag, DateTimeOffset fetchedAt)
    {
        lock (gate) Execute($"UPDATE geo_cache_state SET etag={(etag is null ? "etag" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}' WHERE id=1");
    }

    public IReadOnlyList<GlobePoint> ReadGlobePoints(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate)
        {
            var sql = $"""
                SELECT g.latitude,g.longitude,g.country_code,g.city,COUNT(*),
                       SUM(COALESCE(f.bytes_sent,0)+COALESCE(f.bytes_received,0))
                FROM flows f JOIN geo_locations g ON g.ip=f.remote_address
                WHERE f.last_seen>='{from.ToUniversalTime():O}' AND f.last_seen<'{to.ToUniversalTime():O}'
                GROUP BY g.latitude,g.longitude,g.country_code,g.city
                ORDER BY COUNT(*) DESC LIMIT 250
                """;
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<GlobePoint>();
            try
            {
                while (WinSqlite.Step(statement) == WinSqlite.Row)
                    result.Add(new GlobePoint(WinSqlite.ColumnDouble(statement, 0), WinSqlite.ColumnDouble(statement, 1),
                        NullableTextValue(statement, 2), NullableTextValue(statement, 3), WinSqlite.ColumnInt64(statement, 4),
                        WinSqlite.ColumnInt64(statement, 5)));
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    public PeriodAnalysis ReadPeriodAnalysis(DateTimeOffset from, DateTimeOffset to, int bucketCount = 60)
    {
        if (from >= to) throw new ArgumentOutOfRangeException(nameof(from));
        if (bucketCount is < 12 or > 120) throw new ArgumentOutOfRangeException(nameof(bucketCount));
        lock (gate)
        {
            var fromText = from.ToUniversalTime().ToString("O");
            var toText = to.ToUniversalTime().ToString("O");
            const string app = "COALESCE(NULLIF(process_name,''),'PID ' || process_id)";
            var where = $"last_seen>='{fromText}' AND first_seen<'{toText}' AND layer='logical'";
            var totalsSql = $"SELECT COUNT(*),COUNT(DISTINCT {app}),COUNT(DISTINCT remote_address),COALESCE(SUM(COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)),0),SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END) FROM flows WHERE {where}";
            CheckOperation(WinSqlite.Prepare(db, totalsSql, -1, out var totalsStatement, 0));
            long connections; int applications; int destinations; long bytes; long unknown;
            try
            {
                CheckQueryRow(WinSqlite.Step(totalsStatement));
                connections = WinSqlite.ColumnInt64(totalsStatement, 0);
                applications = (int)WinSqlite.ColumnInt64(totalsStatement, 1);
                destinations = (int)WinSqlite.ColumnInt64(totalsStatement, 2);
                bytes = WinSqlite.ColumnInt64(totalsStatement, 3);
                unknown = WinSqlite.ColumnInt64(totalsStatement, 4);
            }
            finally { WinSqlite.Finalize(totalsStatement); }

            var links = new List<AppDestinationAggregate>();
            const string qualifiedApp = "COALESCE(NULLIF(f.process_name,''),'PID ' || f.process_id)";
            var linksSql = $"SELECT {qualifiedApp},f.remote_address,COALESCE(NULLIF(g.city,''),NULLIF(g.country_code,''),f.remote_address),COUNT(*),COALESCE(SUM(COALESCE(f.bytes_sent,0)+COALESCE(f.bytes_received,0)),0),SUM(CASE WHEN f.bytes_sent IS NULL OR f.bytes_received IS NULL THEN 1 ELSE 0 END) FROM flows f LEFT JOIN geo_locations g ON g.ip=f.remote_address WHERE f.last_seen>='{fromText}' AND f.first_seen<'{toText}' AND f.layer='logical' GROUP BY 1,2,3 ORDER BY 4 DESC,1,2 LIMIT 512";
            CheckOperation(WinSqlite.Prepare(db, linksSql, -1, out var linksStatement, 0));
            try
            {
                while (WinSqlite.Step(linksStatement) == WinSqlite.Row)
                    links.Add(new(Text(linksStatement, 0), Text(linksStatement, 1), Text(linksStatement, 2), WinSqlite.ColumnInt64(linksStatement, 3),
                        WinSqlite.ColumnInt64(linksStatement, 4), WinSqlite.ColumnInt64(linksStatement, 5)));
            }
            finally { WinSqlite.Finalize(linksStatement); }

            var durationSeconds = Math.Max(1, (to - from).TotalSeconds);
            var timeline = new List<AppTimelineAggregate>();
            var timelineSql = $"""
                WITH ranged AS (
                  SELECT {app} AS application,last_seen,
                         COALESCE(bytes_sent,0)+COALESCE(bytes_received,0) AS bytes,
                         CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END AS unknown
                  FROM flows WHERE {where}
                ), top_apps AS (
                  SELECT application FROM ranged GROUP BY application ORDER BY COUNT(*) DESC,application LIMIT 6
                ), bucketed AS (
                  SELECT MIN({bucketCount - 1},MAX(0,CAST((julianday(last_seen)-julianday('{fromText}'))*86400.0/{durationSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}*{bucketCount} AS INTEGER))) AS bucket,
                         CASE WHEN application IN (SELECT application FROM top_apps) THEN application ELSE 'Other' END AS series,
                         bytes,unknown
                  FROM ranged
                )
                SELECT bucket,series,COUNT(*),SUM(bytes),SUM(unknown) FROM bucketed
                GROUP BY bucket,series ORDER BY bucket,series
                """;
            CheckOperation(WinSqlite.Prepare(db, timelineSql, -1, out var timelineStatement, 0));
            try
            {
                while (WinSqlite.Step(timelineStatement) == WinSqlite.Row)
                    timeline.Add(new((int)WinSqlite.ColumnInt64(timelineStatement, 0), Text(timelineStatement, 1),
                        WinSqlite.ColumnInt64(timelineStatement, 2), WinSqlite.ColumnInt64(timelineStatement, 3),
                        WinSqlite.ColumnInt64(timelineStatement, 4)));
            }
            finally { WinSqlite.Finalize(timelineStatement); }

            var coverage = ReadCoverage(from, to);
            var monitoringStartText = NullableScalarText("SELECT MIN(started_at) FROM coverage_sessions");
            var monitoringStartedAt = DateTimeOffset.TryParse(monitoringStartText, out var started) ? started : (DateTimeOffset?)null;
            return new(from, to, connections, applications, destinations, bytes, unknown, coverage,
                monitoringStartedAt, ScalarInt64("SELECT COUNT(*) FROM flows"), links, timeline);
        }
    }

    private double ReadCoverage(DateTimeOffset from, DateTimeOffset to)
    {
        var intervals = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        var sql = $"SELECT started_at,ended_at FROM coverage_sessions WHERE started_at<'{to.ToUniversalTime():O}' AND COALESCE(ended_at,'{to.ToUniversalTime():O}')>'{from.ToUniversalTime():O}' ORDER BY started_at";
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
            {
                var start = DateTimeOffset.Parse(Text(statement, 0));
                var endText = NullableTextValue(statement, 1);
                var end = endText is null ? to : DateTimeOffset.Parse(endText);
                intervals.Add((start < from ? from : start, end > to ? to : end));
            }
        }
        finally { WinSqlite.Finalize(statement); }
        if (intervals.Count == 0) return 0;
        var covered = TimeSpan.Zero;
        var currentStart = intervals[0].Start;
        var currentEnd = intervals[0].End;
        foreach (var interval in intervals.Skip(1))
        {
            if (interval.Start <= currentEnd) { if (interval.End > currentEnd) currentEnd = interval.End; }
            else { covered += currentEnd - currentStart; currentStart = interval.Start; currentEnd = interval.End; }
        }
        covered += currentEnd - currentStart;
        return Math.Clamp(covered.TotalSeconds / (to - from).TotalSeconds, 0, 1);
    }

    public ThreatCacheState ReadThreatCacheState()
    {
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, "SELECT availability,etag,fetched_at,(SELECT COUNT(*) FROM threat_indicators) FROM threat_cache_state WHERE id=1", -1, out var statement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(statement));
                var fetched = NullableTextValue(statement, 2);
                return new(Text(statement, 0), NullableTextValue(statement, 1),
                    fetched is null ? null : DateTimeOffset.Parse(fetched), WinSqlite.ColumnInt64(statement, 3));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    public void ReplaceThreatIndicators(bool available, IReadOnlyList<ThreatIndicator> indicators, string? etag, DateTimeOffset fetchedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                Execute("DELETE FROM threat_indicators");
                const string sql = "INSERT OR REPLACE INTO threat_indicators(kind,value,source,tag,confidence) VALUES(?,?,?,?,?)";
                CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                try
                {
                    foreach (var item in indicators)
                    {
                        if (item.Kind is not ("ip" or "domain" or "cidr") || item.Confidence is not ("high" or "low")) continue;
                        Bind(statement, 1, item.Kind); Bind(statement, 2, item.Value); BindNullable(statement, 3, item.Source);
                        BindNullable(statement, 4, item.Tag); Bind(statement, 5, item.Confidence);
                        CheckDone(WinSqlite.Step(statement)); Check(WinSqlite.Reset(statement)); Check(WinSqlite.ClearBindings(statement));
                    }
                }
                finally { WinSqlite.Finalize(statement); }
                Execute($"UPDATE threat_cache_state SET availability='{(available ? "available" : "unavailable")}',etag={(etag is null ? "NULL" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}' WHERE id=1");
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public void MarkThreatCacheFetched(string? etag, DateTimeOffset fetchedAt)
    {
        lock (gate) Execute($"UPDATE threat_cache_state SET etag={(etag is null ? "etag" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}' WHERE id=1");
    }

    public ThreatReport ReadThreatReport(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate)
        {
            var state = ReadThreatCacheState();
            if (state.Availability != "available") return new(state.Availability, state.IndicatorCount, state.FetchedAt, 0, []);
            var exact = new Dictionary<string, ThreatIndicator>(StringComparer.OrdinalIgnoreCase);
            var cidrs = new List<(uint Network, uint Mask, ThreatIndicator Indicator)>();
            CheckOperation(WinSqlite.Prepare(db, "SELECT kind,value,source,tag,confidence FROM threat_indicators", -1, out var indicatorStatement, 0));
            try
            {
                while (WinSqlite.Step(indicatorStatement) == WinSqlite.Row)
                {
                    var item = new ThreatIndicator(Text(indicatorStatement, 0), Text(indicatorStatement, 1),
                        NullableTextValue(indicatorStatement, 2), NullableTextValue(indicatorStatement, 3), Text(indicatorStatement, 4));
                    if (item.Kind == "ip") exact[item.Value] = item;
                    else if (item.Kind == "cidr" && TryParseCidr(item.Value, out var network, out var mask)) cidrs.Add((network, mask, item));
                }
            }
            finally { WinSqlite.Finalize(indicatorStatement); }

            var findings = new List<ThreatFinding>();
            const string app = "COALESCE(NULLIF(process_name,''),'PID ' || process_id)";
            var sql = $"SELECT remote_address,{app},COUNT(*),COALESCE(SUM(COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)),0),SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END),MAX(last_seen) FROM flows WHERE last_seen>='{from.ToUniversalTime():O}' AND first_seen<'{to.ToUniversalTime():O}' AND layer='logical' GROUP BY 1,2 ORDER BY 3 DESC";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var candidateStatement, 0));
            var checkedDestinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                while (WinSqlite.Step(candidateStatement) == WinSqlite.Row)
                {
                    var address = Text(candidateStatement, 0); checkedDestinations.Add(address);
                    ThreatIndicator? match = exact.GetValueOrDefault(address);
                    if (match is null && TryIpv4(address, out var number))
                        match = cidrs.FirstOrDefault(item => (number & item.Mask) == item.Network).Indicator;
                    if (match is null) continue;
                    findings.Add(new(address, Text(candidateStatement, 1), WinSqlite.ColumnInt64(candidateStatement, 2),
                        WinSqlite.ColumnInt64(candidateStatement, 3), WinSqlite.ColumnInt64(candidateStatement, 4),
                        DateTimeOffset.Parse(Text(candidateStatement, 5)), match.Kind, match.Value, match.Source, match.Tag, match.Confidence));
                }
            }
            finally { WinSqlite.Finalize(candidateStatement); }
            return new(state.Availability, state.IndicatorCount, state.FetchedAt, checkedDestinations.Count, findings);
        }
    }

    private static bool TryParseCidr(string value, out uint network, out uint mask)
    {
        network = mask = 0;
        var parts = value.Split('/');
        if (parts.Length != 2 || !int.TryParse(parts[1], out var prefix) || prefix is < 0 or > 32 || !TryIpv4(parts[0], out var address)) return false;
        mask = prefix == 0 ? 0 : uint.MaxValue << (32 - prefix);
        network = address & mask;
        return true;
    }

    private static bool TryIpv4(string value, out uint number)
    {
        number = 0;
        if (!IPAddress.TryParse(value, out var address) || address.AddressFamily != System.Net.Sockets.AddressFamily.InterNetwork) return false;
        foreach (var octet in address.GetAddressBytes()) number = (number << 8) | octet;
        return true;
    }

    private string? NullableScalarText(string sql)
    {
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try { CheckQueryRow(WinSqlite.Step(statement)); return NullableTextValue(statement, 0); }
        finally { WinSqlite.Finalize(statement); }
    }

    private string ScalarText(string sql)
    {
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try { CheckQueryRow(WinSqlite.Step(statement)); return Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 0)) ?? "unknown"; }
        finally { WinSqlite.Finalize(statement); }
    }

    private void Execute(string sql)
    {
        var code = WinSqlite.Exec(db, sql, 0, 0, out var error);
        if (code == WinSqlite.Ok) return;
        var message = error == 0 ? CurrentError() : Marshal.PtrToStringUTF8(error) ?? "SQLite error";
        if (error != 0) WinSqlite.Free(error);
        throw Failure(code, message);
    }

    private static void Bind(nint statement, int index, string value) => Check(WinSqlite.BindText(statement, index, value, -1, new nint(-1)));
    private static string? NullableTextValue(nint statement, int column) => WinSqlite.ColumnType(statement, column) == 5 ? null : Text(statement, column);
    private static void BindNullable(nint statement, int index, long? value) => Check(value is null ? WinSqlite.BindNull(statement, index) : WinSqlite.BindInt64(statement, index, value.Value));
    private static void BindNullable(nint statement, int index, string? value) { if (value is null) Check(WinSqlite.BindNull(statement, index)); else Bind(statement, index, value); }
    private void CheckDone(int code) { if (code != WinSqlite.Done) throw Failure(code, CurrentError()); }
    private static void CheckRow(int code) { if (code != WinSqlite.Row) throw new InvalidOperationException($"SQLite query failed: {code}"); }
    private static void Check(int code) { if (code != WinSqlite.Ok) throw new InvalidOperationException($"SQLite operation failed: {code}"); }
    private void CheckOperation(int code) { if (code != WinSqlite.Ok) throw Failure(code, CurrentError()); }
    private void CheckQueryRow(int code) { if (code != WinSqlite.Row) throw Failure(code, CurrentError()); }
    private ObservationStoreException Failure(int code, string message)
    {
        var primary = (code == WinSqlite.Ok ? WinSqlite.ExtendedErrorCode(db) : code) & 0xff;
        var kind = primary switch
        {
            WinSqlite.Corrupt or WinSqlite.NotADatabase => StoreFailureKind.Corrupt,
            WinSqlite.Full => StoreFailureKind.DiskFull,
            _ => StoreFailureKind.Unknown,
        };
        return new ObservationStoreException(kind, $"SQLite {kind.ToString().ToLowerInvariant()}: {message}");
    }
    private void TryRollback() { try { Execute("ROLLBACK"); } catch { } }
    private static string Sql(string value) => value.Replace("'", "''", StringComparison.Ordinal);
    private string CurrentError() => Marshal.PtrToStringUTF8(WinSqlite.ErrorMessage(db)) ?? "SQLite error";
    private void ThrowIfDisposed() => ObjectDisposedException.ThrowIf(disposed, this);

    public void Dispose()
    {
        lock (gate)
        {
            if (disposed) return;
            disposed = true;
            if (db != 0) WinSqlite.Close(db);
            db = 0;
        }
    }

    internal void LimitGrowthForTesting(int additionalPages)
    {
        lock (gate)
        {
            var current = ScalarInt64("PRAGMA page_count");
            Execute($"PRAGMA max_page_count={current + additionalPages}");
        }
    }

    internal static void CreateVersion1FixtureForTesting(string fixturePath)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(fixturePath))!);
        Check(WinSqlite.Open(fixturePath, out var fixtureDb, WinSqlite.OpenReadWrite | WinSqlite.OpenCreate | WinSqlite.OpenFullMutex, 0));
        try
        {
            var code = WinSqlite.Exec(fixtureDb, $"PRAGMA journal_mode=WAL; {Version1Schema}", 0, 0, out var error);
            if (error != 0) WinSqlite.Free(error);
            Check(code);
        }
        finally { WinSqlite.Close(fixtureDb); }
    }
}
