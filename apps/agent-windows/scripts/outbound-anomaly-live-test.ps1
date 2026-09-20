param(
    [ValidateSet('Prepare', 'Restore', 'Status')]
    [string]$Mode = 'Status',
    [string]$Database = 'C:\Program Files\EgressView Agent\service\data\egressview-agent.db',
    [string]$ResultPath
)

$ErrorActionPreference = 'Stop'
trap {
    if ($ResultPath) { ($_ | Out-String) | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
    exit 1
}

$source = @'
using System;
using System.Runtime.InteropServices;

public static class EgressViewLiveTestSqlite
{
    [DllImport("winsqlite3", EntryPoint="sqlite3_open_v2", CharSet=CharSet.Ansi)]
    private static extern int Open(string file, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3", EntryPoint="sqlite3_close_v2")]
    private static extern int Close(IntPtr db);
    [DllImport("winsqlite3", EntryPoint="sqlite3_exec", CharSet=CharSet.Ansi)]
    private static extern int ExecNative(IntPtr db, string sql, IntPtr callback, IntPtr arg, out IntPtr error);
    [DllImport("winsqlite3", EntryPoint="sqlite3_free")]
    private static extern void Free(IntPtr value);
    [DllImport("winsqlite3", EntryPoint="sqlite3_prepare_v2", CharSet=CharSet.Ansi)]
    private static extern int Prepare(IntPtr db, string sql, int bytes, out IntPtr statement, IntPtr tail);
    [DllImport("winsqlite3", EntryPoint="sqlite3_step")]
    private static extern int Step(IntPtr statement);
    [DllImport("winsqlite3", EntryPoint="sqlite3_finalize")]
    private static extern int Finalize(IntPtr statement);
    [DllImport("winsqlite3", EntryPoint="sqlite3_column_int64")]
    private static extern long ColumnInt64(IntPtr statement, int index);

    public static void Execute(string file, string sql)
    {
        IntPtr db;
        var rc = Open(file, out db, 0x00000002 | 0x00010000, IntPtr.Zero);
        if (rc != 0) throw new InvalidOperationException("sqlite open failed: " + rc);
        try
        {
            IntPtr error;
            rc = ExecNative(db, "PRAGMA busy_timeout=30000;" + sql, IntPtr.Zero, IntPtr.Zero, out error);
            if (rc == 0) return;
            var message = error == IntPtr.Zero ? "" : Marshal.PtrToStringAnsi(error);
            if (error != IntPtr.Zero) Free(error);
            throw new InvalidOperationException("sqlite execute failed: " + rc + " " + message);
        }
        finally { Close(db); }
    }

    public static long Scalar(string file, string sql)
    {
        IntPtr db;
        var rc = Open(file, out db, 0x00000001 | 0x00010000, IntPtr.Zero);
        if (rc != 0) throw new InvalidOperationException("sqlite open failed: " + rc);
        try
        {
            IntPtr statement;
            rc = Prepare(db, sql, -1, out statement, IntPtr.Zero);
            if (rc != 0) throw new InvalidOperationException("sqlite prepare failed: " + rc);
            try
            {
                rc = Step(statement);
                if (rc != 100) throw new InvalidOperationException("sqlite step failed: " + rc);
                return ColumnInt64(statement, 0);
            }
            finally { Finalize(statement); }
        }
        finally { Close(db); }
    }
}
'@

Add-Type -TypeDefinition $source

$windows = @(
    '2026-09-19T04:15:00.0000000+00:00', '2026-09-19T04:30:00.0000000+00:00',
    '2026-09-19T06:30:00.0000000+00:00', '2026-09-19T06:45:00.0000000+00:00',
    '2026-09-19T16:00:00.0000000+00:00', '2026-09-19T16:15:00.0000000+00:00',
    '2026-09-19T16:30:00.0000000+00:00', '2026-09-19T16:45:00.0000000+00:00',
    '2026-09-19T17:00:00.0000000+00:00', '2026-09-19T17:15:00.0000000+00:00',
    '2026-09-19T17:30:00.0000000+00:00', '2026-09-19T17:45:00.0000000+00:00',
    '2026-09-19T18:00:00.0000000+00:00', '2026-09-19T18:15:00.0000000+00:00',
    '2026-09-19T18:30:00.0000000+00:00', '2026-09-19T18:45:00.0000000+00:00',
    '2026-09-19T19:00:00.0000000+00:00', '2026-09-19T19:15:00.0000000+00:00',
    '2026-09-19T19:30:00.0000000+00:00', '2026-09-19T19:45:00.0000000+00:00',
    '2026-09-19T20:00:00.0000000+00:00', '2026-09-19T20:15:00.0000000+00:00',
    '2026-09-19T20:30:00.0000000+00:00', '2026-09-19T20:45:00.0000000+00:00',
    '2026-09-19T21:00:00.0000000+00:00'
)
$inList = ($windows | ForEach-Object { "'$_'" }) -join ','

if ($Mode -eq 'Prepare') {
    $original = [EgressViewLiveTestSqlite]::Scalar($Database,
        "SELECT COUNT(*) FROM outbound_traffic_windows WHERE window_start IN ($inList) AND bytes_out=0 AND observation_count=0 AND observations_with_bytes=0 AND application_count=0 AND destination_count=0 AND largest_application_bytes_out=0 AND anomaly_kind IS NULL")
    if ($original -ne $windows.Count) {
        throw "Refusing to prepare: expected $($windows.Count) untouched empty windows, found $original."
    }
    [EgressViewLiveTestSqlite]::Execute($Database, @"
BEGIN IMMEDIATE;
UPDATE outbound_traffic_windows
SET bytes_out=0, observation_count=10, observations_with_bytes=10,
    application_count=1, destination_count=1, largest_application_bytes_out=0
WHERE window_start IN ($inList);
COMMIT;
"@)
}
elseif ($Mode -eq 'Restore') {
    [EgressViewLiveTestSqlite]::Execute($Database, @"
BEGIN IMMEDIATE;
UPDATE outbound_traffic_windows
SET bytes_out=0, observation_count=0, observations_with_bytes=0,
    application_count=0, destination_count=0, largest_application_bytes_out=0,
    anomaly_kind=NULL
WHERE window_start IN ($inList);
COMMIT;
"@)
}

$usable = [EgressViewLiveTestSqlite]::Scalar($Database,
    'SELECT COUNT(*) FROM outbound_traffic_windows WHERE observation_count >= 10 AND observations_with_bytes * 10 >= observation_count * 8')
$anomalies = [EgressViewLiveTestSqlite]::Scalar($Database,
    'SELECT COUNT(*) FROM outbound_traffic_windows WHERE anomaly_kind IS NOT NULL')
$result = [pscustomobject]@{ Mode = $Mode; UsableBaselineWindows = $usable; Anomalies = $anomalies } | ConvertTo-Json -Compress
if ($ResultPath) { $result | Set-Content -LiteralPath $ResultPath -Encoding UTF8 }
$result
