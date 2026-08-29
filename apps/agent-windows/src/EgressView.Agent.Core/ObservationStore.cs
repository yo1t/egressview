using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

public sealed class ObservationStore : IDisposable
{
    private const string Schema = """
        PRAGMA journal_mode=WAL;
        PRAGMA synchronous=NORMAL;
        PRAGMA foreign_keys=ON;
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
        UPDATE schema_version SET version=2 WHERE version < 2;
        """;

    private readonly object gate = new();
    private nint db;
    private bool disposed;

    public ObservationStore(string path)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        Check(WinSqlite.Open(path, out db, WinSqlite.OpenReadWrite | WinSqlite.OpenCreate | WinSqlite.OpenFullMutex, 0));
        Execute(Schema);
    }

    public void WriteBatch(IReadOnlyList<NetworkObservation> observations)
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
                      remote_address,remote_port,bytes_sent,bytes_received,layer,interface_id,source)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
                    """;
                const string flowSql = """
                    INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,
                      process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id)
                    VALUES(?,?,?,?,?,?,?,?,?,'etw',?,?,?,?)
                    ON CONFLICT(flow_key) DO UPDATE SET
                      last_seen=excluded.last_seen,
                      origin=CASE WHEN flows.origin='snapshot' THEN 'both' ELSE flows.origin END,
                      bytes_sent=CASE WHEN flows.bytes_sent IS NULL THEN excluded.bytes_sent ELSE flows.bytes_sent+excluded.bytes_sent END,
                      bytes_received=CASE WHEN flows.bytes_received IS NULL THEN excluded.bytes_received ELSE flows.bytes_received+excluded.bytes_received END,
                      layer=excluded.layer,
                      interface_id=COALESCE(excluded.interface_id,flows.interface_id)
                    """;
                Check(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                Check(WinSqlite.Prepare(db, flowSql, -1, out var flowStatement, 0));
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
                        CheckDone(WinSqlite.Step(flowStatement)); Check(WinSqlite.Reset(flowStatement)); Check(WinSqlite.ClearBindings(flowStatement));
                    }
                }
                finally { WinSqlite.Finalize(statement); WinSqlite.Finalize(flowStatement); }
                Execute("COMMIT");
            }
            catch
            {
                Execute("ROLLBACK");
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
                    Execute($"INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id) VALUES('{key}','{flow.Protocol}','{flow.LocalAddress}',{flow.LocalPort},'{flow.RemoteAddress}',{flow.RemotePort},{flow.ProcessId},'{startedAt:O}','{startedAt:O}','snapshot',NULL,NULL,'logical',NULL) ON CONFLICT(flow_key) DO NOTHING");
                }
                Execute($"INSERT INTO coverage_sessions(started_at,snapshot_count) VALUES('{startedAt:O}',{snapshot.Count})");
                var id = ScalarInt64("SELECT last_insert_rowid()");
                Execute("COMMIT");
                return id;
            }
            catch { Execute("ROLLBACK"); throw; }
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
        Check(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try { CheckRow(WinSqlite.Step(statement)); return WinSqlite.ColumnInt64(statement, 0); }
        finally { WinSqlite.Finalize(statement); }
    }

    private string ScalarText(string sql)
    {
        Check(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try { CheckRow(WinSqlite.Step(statement)); return Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 0)) ?? "unknown"; }
        finally { WinSqlite.Finalize(statement); }
    }

    private void Execute(string sql)
    {
        var code = WinSqlite.Exec(db, sql, 0, 0, out var error);
        if (code == WinSqlite.Ok) return;
        var message = error == 0 ? CurrentError() : Marshal.PtrToStringUTF8(error) ?? "SQLite error";
        if (error != 0) WinSqlite.Free(error);
        throw new InvalidOperationException(message);
    }

    private static void Bind(nint statement, int index, string value) => Check(WinSqlite.BindText(statement, index, value, -1, new nint(-1)));
    private static void BindNullable(nint statement, int index, long? value) => Check(value is null ? WinSqlite.BindNull(statement, index) : WinSqlite.BindInt64(statement, index, value.Value));
    private static void BindNullable(nint statement, int index, string? value) { if (value is null) Check(WinSqlite.BindNull(statement, index)); else Bind(statement, index, value); }
    private static void CheckDone(int code) { if (code != WinSqlite.Done) throw new InvalidOperationException($"SQLite step failed: {code}"); }
    private static void CheckRow(int code) { if (code != WinSqlite.Row) throw new InvalidOperationException($"SQLite query failed: {code}"); }
    private static void Check(int code) { if (code != WinSqlite.Ok) throw new InvalidOperationException($"SQLite operation failed: {code}"); }
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
}
