using System.Runtime.InteropServices;
using System.Net;

namespace EgressView.Agent.Core;

public sealed partial class ObservationStore : IDisposable
{
    private const int CurrentSchemaVersion = 29;
    public static readonly int[] AllowedRetentionDays = [1, 7, 30, 90];
    public const int DefaultRawRetentionDays = 14;
    public static readonly TimeSpan CoverageHeartbeatInterval = TimeSpan.FromSeconds(5);
    public static readonly TimeSpan CoverageStaleAfter = TimeSpan.FromSeconds(15);
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
    /// What makes two observations the same connection: the column that
    /// names it.
    ///
    /// This used to be an expression rebuilding the key out of five columns on
    /// every row it touched, because the row carried the whole flow. The row
    /// now carries the flow's id, which is the same question already answered.
    /// It keeps UDP's rule without restating it -- the key the flows table is
    /// built on already drops the remote end there, so that one socket talking
    /// to several peers stays one connection.
    private const string FlowIdentity = "flow_id";

    /// Ticks to the unix seconds strftime wants, in SQL.
    ///
    /// Only where a calendar is genuinely needed -- the hour a row belongs to.
    /// Comparisons and bucket arithmetic stay in ticks, where they are integer
    /// comparisons on an indexed column rather than a date parsed per row.
    private const string ObservedUnixSeconds = "(observed_at/10000000-62135596800)";

    /// The hour a row belongs to, in the text form chart_hourly is keyed on.
    private const string ObservedHourStart =
        "strftime('%Y-%m-%dT%H:00:00.0000000+00:00'," + ObservedUnixSeconds + ",'unixepoch')";

    /// Which side of the network card a row is, for the fold.
    private static readonly string ObservedScope =
        $"CASE WHEN {DestinationScope.LoopbackSql()} THEN 'local' ELSE 'outbound' END";

    /// The folded hours a period may count: everything except what is known
    /// to have stayed here. 'mixed' is included because excluding it would
    /// drop every hour folded before v28 -- incomplete, not absent.
    private const string CountableScopes = "scope IN ('outbound','mixed')";

    /// The flow a row of the old shape belonged to, expressed in SQL.
    ///
    /// The same key StartupSnapshot.FlowKey builds in C#. It exists for the
    /// v26 migration and for nothing else: after it, the id is on the row.
    private const string LegacyFlowKey =
        "CASE WHEN o.protocol='UDP' " +
        "THEN 'UDP|'||o.local_address||'|'||o.local_port||'|'||o.process_id " +
        "ELSE 'TCP|'||o.local_address||'|'||o.local_port||'|'||o.remote_address||'|'||o.remote_port||'|'||o.process_id END";

    /// Observations stop carrying a copy of their own flow.
    ///
    /// A row is one flow for one second, and it was writing the flow out again
    /// every second: the protocol, the local address, the local port, the
    /// process id and the interface, as text, on every one of thirty-one
    /// million rows. Measured on this machine, 67 of about 150 bytes a row --
    /// interface_id alone was 37.9, a GUID string with nine distinct values in
    /// the whole database.
    ///
    /// What moves is what was measured to be constant within a flow, under the
    /// same key the flows table is built on, across a day of real traffic:
    /// protocol, local_address, local_port, process_id and interface_id never
    /// varied once.
    ///
    /// What stays is what did vary, and the reason matters more than the
    /// saving:
    ///
    ///  - remote_address and remote_port. The key drops the remote end for
    ///    UDP, and one UDP socket does talk to several peers: 8,416 flows and
    ///    250,361 rows in a day, a quarter of everything. Moving them would
    ///    lose which peer a datagram went to.
    ///  - process_name and remote_hostname, which differ between non-null
    ///    values on real rows -- a reused pid, an address answering to more
    ///    than one name. Which name it was at that second exists only here.
    ///  - layer, for a different reason: it is a filter in eight read paths
    ///    and worth 7.5 bytes. Joining for it would spend the query work of
    ///    P3-149 to save a ninth of what the rest saves.
    ///
    /// observed_at stays text. Epoch integers would save another 25 bytes a
    /// row and touch fifty-four more places, and a migration that changes both
    /// the shape and the meaning of time is two migrations wearing one coat.
    /// The time on a row stops being a sentence.
    ///
    /// "2026-09-22T00:00:00.0368299+00:00" is thirty-three bytes of text on
    /// every row, and after v26 that is 38% of what a row costs -- the single
    /// largest thing left on it. As ticks it is eight, and the comparisons
    /// against it become integer comparisons rather than string ones.
    ///
    /// Ticks, not epoch seconds. Every row carries a fraction of a second and
    /// today all 379,869 of them did: three rows inside one second, each with
    /// its own hundred-nanosecond part. Seconds would have been twenty-five
    /// bytes saved and a hundred nanoseconds of evidence discarded, and this
    /// file has already had to be told three times this week that the thing
    /// being moved was carrying something.
    ///
    /// UTC only, which is what the column already held: everything written
    /// here goes through ToUniversalTime first, so no offset is lost.
    /// The folded hours learn which side of the network card they are on.
    ///
    /// #628 took loopback out of the counts and out of the destination chart,
    /// and could not take it out of the timeline: chart_hourly folds by
    /// application and layer and has no destination to filter on. So the
    /// tiles said one thing and the chart under them said another, which is
    /// the fault this repository has spent the day finding in other places.
    ///
    /// Summing the per-destination table instead does not work. Its flow_count
    /// is per destination, and flow_key drops the remote end for UDP, so one
    /// socket talking to several peers is counted once per peer: measured on
    /// this machine, 1,712 of 10,044 hours exceeded chart_hourly's own count,
    /// the worst by 8.75 times. It is also younger -- v25 -- so eight days of
    /// history have no breakdown at all.
    ///
    /// Hours already folded are marked 'mixed', because that is what they are.
    /// Calling them 'outbound' would be a claim about data that was averaged
    /// away, and the timeline would be quietly wrong for thirty days instead
    /// of honestly incomplete for thirty days.
    private const string Version28Schema = """
        CREATE TABLE chart_hourly_v28(
          bucket_start TEXT NOT NULL,
          application TEXT NOT NULL,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          scope TEXT NOT NULL CHECK(scope IN ('outbound','local','mixed')),
          observation_count INTEGER NOT NULL,
          flow_count INTEGER NOT NULL DEFAULT 0,
          bytes_sent INTEGER NOT NULL,
          bytes_received INTEGER NOT NULL,
          bytes_unknown INTEGER NOT NULL,
          PRIMARY KEY(bucket_start,application,layer,scope)
        );
        """;

    private const string Version29Schema = """
        ALTER TABLE flows ADD COLUMN process_instance_id TEXT NOT NULL DEFAULT 'legacy:unknown';
        ALTER TABLE observations ADD COLUMN process_instance_id TEXT NOT NULL DEFAULT 'legacy:unknown';
        ALTER TABLE delivery_queue ADD COLUMN process_instance_id TEXT NOT NULL DEFAULT 'legacy:unknown';
        CREATE TABLE IF NOT EXISTS startup_udp_placeholders(
          coverage_id INTEGER NOT NULL,
          local_address TEXT NOT NULL,
          local_port INTEGER NOT NULL,
          process_id INTEGER NOT NULL,
          process_name TEXT,
          process_instance_id TEXT NOT NULL,
          FOREIGN KEY(coverage_id) REFERENCES coverage_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS startup_udp_placeholders_coverage ON startup_udp_placeholders(coverage_id);
        """;

    private const string Version27Schema = """
        CREATE TABLE observations_v27(
          id INTEGER PRIMARY KEY,
          observed_at INTEGER NOT NULL,
          flow_id INTEGER NOT NULL,
          remote_address TEXT NOT NULL,
          remote_port INTEGER NOT NULL,
          bytes_sent INTEGER,
          bytes_received INTEGER,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          source TEXT NOT NULL CHECK(source IN ('etw','snapshot')),
          process_name TEXT,
          remote_hostname TEXT
        );
        """;

    private const string Version26Schema = """
        CREATE TABLE observations_v26(
          id INTEGER PRIMARY KEY,
          observed_at TEXT NOT NULL,
          flow_id INTEGER NOT NULL,
          remote_address TEXT NOT NULL,
          remote_port INTEGER NOT NULL,
          bytes_sent INTEGER,
          bytes_received INTEGER,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          source TEXT NOT NULL CHECK(source IN ('etw','snapshot')),
          process_name TEXT,
          remote_hostname TEXT
        );
        """;

    private const string Version25Schema = """
        CREATE TABLE IF NOT EXISTS chart_hourly_destination(
          bucket_start TEXT NOT NULL,
          application TEXT NOT NULL,
          remote_address TEXT NOT NULL,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          remote_hostname TEXT,
          flow_count INTEGER NOT NULL,
          observation_count INTEGER NOT NULL,
          bytes_sent INTEGER NOT NULL,
          bytes_received INTEGER NOT NULL,
          bytes_unknown INTEGER NOT NULL,
          PRIMARY KEY(bucket_start,application,remote_address,layer)
        );
        CREATE INDEX IF NOT EXISTS chart_hourly_destination_bucket ON chart_hourly_destination(bucket_start);
        """;
    private const string Version24Schema = """
        UPDATE delivery_queue SET first_observed_at=last_observed_at, last_observed_at=first_observed_at
          WHERE last_observed_at<first_observed_at;
        UPDATE flows SET first_seen=last_seen, last_seen=first_seen
          WHERE last_seen<first_seen;
        """;
    private const string Version23Schema = """
        ALTER TABLE delivery_state ADD COLUMN blocked_batch_id TEXT;
        ALTER TABLE delivery_state ADD COLUMN blocked_batch_rejections INTEGER NOT NULL DEFAULT 0;
        """;
    private const string Version22Schema = """
        ALTER TABLE chart_hourly ADD COLUMN flow_count INTEGER NOT NULL DEFAULT 0;
        """;
    private const string Version21Schema = """
        ALTER TABLE geo_locations ADD COLUMN source TEXT NOT NULL DEFAULT 'hub';
        """;
    private const string Version20Schema = """
        CREATE TABLE IF NOT EXISTS geo_lookup_misses(
          ip TEXT PRIMARY KEY,
          missed_at TEXT NOT NULL
        );
        """;
    private const string Version19Schema = """
        ALTER TABLE threat_cache_state ADD COLUMN source TEXT NOT NULL DEFAULT 'none';
        """;
    private const string Version9Schema = """
        ALTER TABLE observations ADD COLUMN remote_hostname TEXT;
        ALTER TABLE flows ADD COLUMN remote_hostname TEXT;
        """;
    private const string Version10Schema = """
        CREATE TABLE IF NOT EXISTS chart_hourly(
          bucket_start TEXT NOT NULL,
          application TEXT NOT NULL,
          layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
          observation_count INTEGER NOT NULL,
          bytes_sent INTEGER NOT NULL,
          bytes_received INTEGER NOT NULL,
          bytes_unknown INTEGER NOT NULL,
          PRIMARY KEY(bucket_start,application,layer)
        );
        CREATE INDEX IF NOT EXISTS chart_hourly_bucket ON chart_hourly(bucket_start);
        CREATE TABLE IF NOT EXISTS chart_hourly_state(
          id INTEGER PRIMARY KEY CHECK(id=1),
          folded_through TEXT NOT NULL
        );
        """;
    private const string Version11Schema = """
        ALTER TABLE coverage_sessions ADD COLUMN confirmed_at TEXT;
        ALTER TABLE coverage_sessions ADD COLUMN interrupted INTEGER NOT NULL DEFAULT 0 CHECK(interrupted IN (0,1));
        UPDATE coverage_sessions SET confirmed_at=COALESCE(ended_at,started_at);
        """;
    private const string Version12Schema = """
        CREATE TABLE IF NOT EXISTS local_history_settings(
          id INTEGER PRIMARY KEY CHECK(id=1),
          retention_days INTEGER NOT NULL DEFAULT 30 CHECK(retention_days IN (1,7,30,90)),
          last_cleanup_at TEXT
        );
        INSERT OR IGNORE INTO local_history_settings(id) VALUES(1);
        """;
    private const string Version13Schema = """
        ALTER TABLE delivery_queue ADD COLUMN remote_hostname TEXT;
        """;
    private const string Version14Schema = """
        CREATE TABLE IF NOT EXISTS sleep_periods(
          id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,
          ended_at TEXT
        );
        CREATE INDEX IF NOT EXISTS sleep_periods_started ON sleep_periods(started_at);
        """;

    /// Why each run of each process ended.
    ///
    /// Diagnostics describe the agent that is running. A agent that has
    /// stopped writes nothing, so the one question a user has after a silent
    /// gap -- what happened -- is the one question the diagnostics cannot
    /// answer. This is written at the start of a run rather than at the end,
    /// because a process that crashes does not get to write anything.
    private const string Version15Schema = """
        CREATE TABLE IF NOT EXISTS run_history(
          id INTEGER PRIMARY KEY,
          component TEXT NOT NULL CHECK(component IN ('service','ui')),
          version TEXT NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT,
          ended_at TEXT,
          ending TEXT NOT NULL CHECK(ending IN ('running','clean','unexpected','faulted')),
          fault TEXT
        );
        CREATE INDEX IF NOT EXISTS run_history_component ON run_history(component,id);
        """;

    /// An OS shutdown and a crash both leave a run that never wrote its own
    /// ending, and v15 had no way to tell them apart: every restart of the
    /// machine filed one more "unexpected". On a laptop rebooted five times a
    /// week that buries the one run that really did crash.
    ///
    /// SQLite cannot widen a CHECK constraint in place, so the table is
    /// rebuilt. The copy carries every existing row: what was recorded under
    /// the old vocabulary stays exactly as it was recorded.
    private const string Version16Schema = """
        CREATE TABLE IF NOT EXISTS run_history_next(
          id INTEGER PRIMARY KEY,
          component TEXT NOT NULL CHECK(component IN ('service','ui')),
          version TEXT NOT NULL,
          started_at TEXT NOT NULL,
          heartbeat_at TEXT,
          ended_at TEXT,
          ending TEXT NOT NULL CHECK(ending IN ('running','clean','unexpected','faulted','system-shutdown')),
          fault TEXT
        );
        INSERT INTO run_history_next(id,component,version,started_at,heartbeat_at,ended_at,ending,fault)
          SELECT id,component,version,started_at,heartbeat_at,ended_at,ending,fault FROM run_history;
        DROP TABLE run_history;
        ALTER TABLE run_history_next RENAME TO run_history;
        CREATE INDEX IF NOT EXISTS run_history_component ON run_history(component,id);
        """;

    /// One row per completed fifteen-minute window, so "unusual" is measured
    /// against what this machine actually does rather than against a number
    /// someone picked.
    ///
    /// The windows are kept, not the observations they came from: a baseline
    /// has to outlive the raw retention window, and seven days of summaries is
    /// a few hundred rows where seven days of observations is millions.
    private const string Version17Schema = """
        CREATE TABLE IF NOT EXISTS outbound_traffic_windows(
          window_start TEXT PRIMARY KEY,
          bytes_out INTEGER NOT NULL,
          observation_count INTEGER NOT NULL,
          observations_with_bytes INTEGER NOT NULL,
          application_count INTEGER NOT NULL,
          destination_count INTEGER NOT NULL,
          largest_application_bytes_out INTEGER NOT NULL,
          anomaly_kind TEXT CHECK(anomaly_kind IN ('large-transfer','distributed-transfer'))
        );
        """;

    /// Countries worked out on this PC, from a table on this PC.
    ///
    /// Kept apart from geo_locations because that table's coordinates are NOT
    /// NULL and a country database has no coordinates to put there. Inventing
    /// a latitude to satisfy a column would put a made-up place on the globe,
    /// which is worse than a country with no pin.
    private const string Version18Schema = """
        CREATE TABLE IF NOT EXISTS local_country_cache(
          ip TEXT PRIMARY KEY,
          country_code TEXT NOT NULL,
          resolved_at TEXT NOT NULL
        );
        """;

    private readonly object gate = new();
    private nint db;
    private bool disposed;
    private readonly string path;
    private string lastVerifiedIntegrity = "ok";

    public long SchemaVersion { get { lock (gate) return ScalarInt64("SELECT version FROM schema_version"); } }

    /// How long opening this database took, and how much of that was the
    /// integrity check.
    ///
    /// After a reboot the agent answered nothing for 132 seconds and the
    /// tray icon took 115, so the machine looked like it had not come back
    /// (P3-134). Which part of the startup that is has to be measured rather
    /// than guessed, and measured on the database people actually have --
    /// this one is 6.5 GB -- so the product records it on every start.
    public long OpenMilliseconds { get; private set; }

    public long IntegrityCheckMilliseconds { get; private set; }

    /// Whether the check at open read every page or only the structure, so the
    /// diagnostics say which question was actually answered.
    public bool IntegrityCheckWasDeep { get; private set; }

    /// Told what each migration is doing, as it starts doing it.
    ///
    /// The file beside the database is what a window reads, and a window is a
    /// hard thing to assert. This is the same report, handed to whoever asked
    /// for it: without it, nothing checks that the number written down is the
    /// number of rows there actually are, and a migration that reported zero
    /// would look exactly like one that reported the truth.
    private readonly Action<MigrationProgress>? onMigration;

    public ObservationStore(string path, Action<MigrationProgress>? onMigration = null)
    {
        this.onMigration = onMigration;
        ArgumentException.ThrowIfNullOrWhiteSpace(path);
        this.path = Path.GetFullPath(path);
        Directory.CreateDirectory(Path.GetDirectoryName(this.path)!);
        Check(WinSqlite.Open(this.path, out db, WinSqlite.OpenReadWrite | WinSqlite.OpenCreate | WinSqlite.OpenFullMutex, 0));
        var opened = System.Diagnostics.Stopwatch.StartNew();
        try { Initialize(); }
        catch { if (db != 0) WinSqlite.Close(db); db = 0; throw; }
        OpenMilliseconds = opened.ElapsedMilliseconds;
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
            Execute($"BEGIN IMMEDIATE; {Version1Schema} {Version2Schema} {Version3Schema} {Version4Schema} {Version5Schema} {Version6Schema} {Version7Schema} {Version8Schema} {Version9Schema} {Version10Schema} {Version11Schema} {Version12Schema} {Version13Schema} {Version14Schema} {Version15Schema} {Version16Schema} {Version17Schema} {Version18Schema} {Version19Schema} {Version20Schema} {Version21Schema} {Version22Schema} {Version23Schema} {Version24Schema} {Version25Schema} {Version27Schema} {Version28Schema} DROP TABLE observations; ALTER TABLE observations_v27 RENAME TO observations; DROP TABLE chart_hourly; ALTER TABLE chart_hourly_v28 RENAME TO chart_hourly; CREATE INDEX IF NOT EXISTS chart_hourly_bucket ON chart_hourly(bucket_start); CREATE INDEX IF NOT EXISTS observations_observed_at ON observations(observed_at); {Version29Schema} UPDATE schema_version SET version={CurrentSchemaVersion}; COMMIT;");
            return;
        }

        EnsureIntegrity();
        var version = ScalarInt64("SELECT version FROM schema_version");
        if (version > CurrentSchemaVersion)
            throw new ObservationStoreException(StoreFailureKind.SchemaTooNew, $"Database schema {version} is newer than supported schema {CurrentSchemaVersion}.");
        if (version < 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, $"Database schema version {version} is invalid.");
        var startedAt = version;
        try
        {
        if (version == 1) { MigrateVersion1To2(); version = 2; }
        if (version == 2) { MigrateVersion2To3(); version = 3; }
        if (version == 3) { MigrateVersion3To4(); version = 4; }
        if (version == 4) { MigrateVersion4To5(); version = 5; }
        if (version == 5) { MigrateVersion5To6(); version = 6; }
        if (version == 6) { MigrateVersion6To7(); version = 7; }
        if (version == 7) { MigrateVersion7To8(); version = 8; }
        if (version == 8) { MigrateVersion8To9(); version = 9; }
        if (version == 9) { MigrateVersion9To10(); version = 10; }
        if (version == 10) { MigrateVersion10To11(); version = 11; }
        if (version == 11) { MigrateVersion11To12(); version = 12; }
        if (version == 12) { MigrateVersion12To13(); version = 13; }
        if (version == 13) { MigrateVersion13To14(); version = 14; }
        if (version == 14) { MigrateVersion14To15(); version = 15; }
        if (version == 15) { MigrateVersion15To16(); version = 16; }
        if (version == 16) { MigrateVersion16To17(); version = 17; }
        if (version == 17) { MigrateVersion17To18(); version = 18; }
        if (version == 18) { MigrateVersion18To19(); version = 19; }
        if (version == 19) { MigrateVersion19To20(); version = 20; }
        if (version == 20) { MigrateVersion20To21(); version = 21; }
        if (version == 21) { MigrateVersion21To22(); version = 22; }
        if (version == 22) { MigrateVersion22To23(); version = 23; }
        if (version == 23) { MigrateVersion23To24(); version = 24; }
        if (version == 24) { MigrateVersion24To25(); version = 25; }
        if (version == 25) { MigrateVersion25To26(); version = 26; }
        if (version == 26) { MigrateVersion26To27(); version = 27; }
        if (version == 27) { MigrateVersion27To28(); version = 28; }
        if (version == 28) MigrateVersion28To29();
        ValidateSchema();
        }
        catch { ReportMigrationFailed(startedAt); throw; }
        MigrationProgress.Clear(path);
        PruneMigrationBackups(CurrentSchemaVersion);
    }

    /// Threat information gains the source it came from.
    ///
    /// A count and a timestamp never said whether the indicators in use were
    /// the Hub's, the public lists', or a cache left over from days ago. The
    /// existing row is set to 'none' rather than guessed at: the Agent does
    /// not know where data fetched before this column existed came from, and
    /// saying so is better than picking the likeliest answer.
    private void MigrateVersion18To19()
    {
        CreateMigrationBackup(19);
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version19Schema + " UPDATE schema_version SET version=19 WHERE version=18; COMMIT;");
            PruneMigrationBackups(19);
        }
        catch { TryRollback(); throw; }
    }

    /// Remembers the addresses a lookup could not place.
    ///
    /// Without this the same addresses are asked about on every run, for ever:
    /// a destination no service can place is exactly the destination that
    /// stays in the "not placed" list. Measured on one PC, that spent the
    /// whole daily allowance on addresses that were never going to be
    /// answered, so the ones that would have been went unplaced instead.
    private void MigrateVersion19To20()
    {
        CreateMigrationBackup(20);
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version20Schema + " UPDATE schema_version SET version=20 WHERE version=19; COMMIT;");
            PruneMigrationBackups(20);
        }
        catch { TryRollback(); throw; }
    }

    /// Locations gain the source that supplied them.
    ///
    /// The daily cache arrives as a whole and replaces what was there, which
    /// was right while the Hub was the only source. It is not right now: an
    /// address looked up one at a time, and paid for out of a daily allowance,
    /// was thrown away on the next cache fetch and bought again. Measured on
    /// one PC, that spent 132 of 500 in an afternoon on addresses already
    /// placed once.
    ///
    /// Rows that predate this column are the Hub's, which is what the default
    /// says, because until now nothing else could write one.
    private void MigrateVersion20To21()
    {
        CreateMigrationBackup(21);
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version21Schema + " UPDATE schema_version SET version=21 WHERE version=20; COMMIT;");
            PruneMigrationBackups(21);
        }
        catch { TryRollback(); throw; }
    }

    /// The chart learns to count connections rather than rows.
    ///
    /// The timeline plotted observation_count and the legend called it
    /// connections. While the collector wrote a row per packet those were not
    /// close: measured on one machine, a single minute held 310,764 rows and
    /// 215 connections, and the chart drew 310,764 -- a spike 1,445 times the
    /// truth that flattened every other bar on the screen, while the summary
    /// above it said 2,647 connections for the same hour. Two numbers on one
    /// screen, the same name, two orders of magnitude apart.
    ///
    /// Buckets already folded have no count to convert to, because the rows
    /// they were made from are summarised away. Those inside the raw retention
    /// window are dropped and folded again from the observations, which still
    /// exist. Older ones keep a flow_count of zero, and the chart reads that
    /// as "this hour cannot say" rather than drawing a zero as a fact.
    private void MigrateVersion21To22()
    {
        CreateMigrationBackup(22);
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version22Schema);
            // Everything the observations can still rebuild, rebuilt. The
            // watermark moves back with it, so the ordinary fold does the work
            // on its own schedule instead of this migration holding the
            // database while it recomputes.
            // Read as text on purpose: this runs before v27, when the column
            // still spells its times out. A helper that knows only the new
            // shape is wrong here, and was -- the v1 fixture migrating through
            // every version is what said so.
            var oldestRaw = NullableScalarText("SELECT MIN(observed_at) FROM observations");
            if (oldestRaw is not null)
            {
                var oldest = DateTimeOffset.Parse(oldestRaw).ToUniversalTime();
                var boundary = new DateTimeOffset(oldest.Year, oldest.Month, oldest.Day, oldest.Hour, 0, 0, TimeSpan.Zero);
                Execute($"DELETE FROM chart_hourly WHERE bucket_start>='{boundary:O}'");
                Execute($"UPDATE chart_hourly_state SET folded_through='{boundary:O}' WHERE folded_through>'{boundary:O}'");
            }
            Execute("UPDATE schema_version SET version=22 WHERE version=21");
            Execute("COMMIT");
            PruneMigrationBackups(22);
        }
        catch { TryRollback(); throw; }
    }

    /// Delivery remembers which batch keeps being refused.
    ///
    /// A batch the Hub will never accept was retried for ever, and because the
    /// next batch cannot be prepared while one is outstanding, everything
    /// behind it stopped. Measured on a real machine: one batch of 107
    /// observations claimed at 01:34:33Z was still claimed three hours later,
    /// the queue behind it sat at its 10,000 ceiling, and 17,813 observations
    /// had been dropped to make room. Losing 107 that the Hub refuses is the
    /// smaller loss by two orders of magnitude, and the only one that ends.
    private void MigrateVersion22To23()
    {
        CreateMigrationBackup(23);
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version23Schema + " UPDATE schema_version SET version=23 WHERE version=22; COMMIT;");
            PruneMigrationBackups(23);
        }
        catch { TryRollback(); throw; }
    }

    /// A flow's first and last times are put back in order.
    ///
    /// Both upserts assigned the last time from whichever observation arrived
    /// most recently, which is only correct if observations arrive in time
    /// order. They do not: ETW callbacks are not strictly ordered, and the
    /// per-second summing emits a bucket when the event timeline passes it
    /// rather than when its own traffic happened. A later arrival carrying an
    /// earlier time moved last_observed_at behind first_observed_at.
    ///
    /// The Hub checks exactly that, and answers 400 for the whole batch. On
    /// this machine 31 of 10,000 queued observations were inverted -- about
    /// one in three hundred, which is enough that half of all 200-observation
    /// batches carried one, and every one of those was refused. Delivery
    /// stopped for hours at a time and the queue overflowed at the far end.
    ///
    /// Swapped rather than clamped: both times are real, they are simply
    /// recorded the wrong way round, and the smaller one is the first.
    private void MigrateVersion23To24()
    {
        CreateMigrationBackup(24);
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version24Schema + " UPDATE schema_version SET version=24 WHERE version=23; COMMIT;");
            PruneMigrationBackups(24);
        }
        catch { TryRollback(); throw; }
    }

    /// Destinations get the hourly summary applications already had.
    ///
    /// The per-destination byte figures had no aggregate to read, so a period
    /// scanned every raw observation in it. Measured on this machine, a day
    /// held 6,500,653 of them and that one query took 5.33 seconds, on the
    /// single pipe the window also asks "is the agent running" -- which is
    /// what the screen meant when it said it could not get the status.
    ///
    /// The existing chart rows are dropped back to where raw observations
    /// still reach, and the ordinary fold rebuilds both tables from there on
    /// its own schedule. It is bounded per pass, so a database with a
    /// fortnight of raw history catches up over an hour of one-minute passes
    /// rather than holding a single transaction open for all of it. Hours
    /// older than the raw retention keep their application-level rows and
    /// gain no destination rows: those observations are gone, and the period
    /// reports no destination bytes rather than inventing them.
    private void MigrateVersion24To25()
    {
        CreateMigrationBackup(25);
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version25Schema);
            // Read as text on purpose: this runs before v27, when the column
            // still spells its times out. A helper that knows only the new
            // shape is wrong here, and was -- the v1 fixture migrating through
            // every version is what said so.
            var oldestRaw = NullableScalarText("SELECT MIN(observed_at) FROM observations");
            if (oldestRaw is not null)
            {
                var oldest = DateTimeOffset.Parse(oldestRaw).ToUniversalTime();
                var boundary = new DateTimeOffset(oldest.Year, oldest.Month, oldest.Day, oldest.Hour, 0, 0, TimeSpan.Zero);
                Execute($"DELETE FROM chart_hourly WHERE bucket_start>='{boundary:O}'");
                Execute($"UPDATE chart_hourly_state SET folded_through='{boundary:O}' WHERE folded_through>'{boundary:O}'");
            }
            Execute("UPDATE schema_version SET version=25 WHERE version=24");
            Execute("COMMIT");
            PruneMigrationBackups(25);
        }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion1To2()
    {
        CreateMigrationBackup(2);
        try
        {
            Execute($"BEGIN IMMEDIATE; {Version2Schema} UPDATE schema_version SET version=2 WHERE version=1; COMMIT;");
            PruneMigrationBackups(2);
        }
        catch
        {
            TryRollback();
            throw;
        }
    }

    private void MigrateVersion2To3()
    {
        CreateMigrationBackup(3);
        try { Execute($"BEGIN IMMEDIATE; {Version3Schema} UPDATE schema_version SET version=3 WHERE version=2; COMMIT;"); PruneMigrationBackups(3); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion3To4()
    {
        CreateMigrationBackup(4);
        try { Execute($"BEGIN IMMEDIATE; {Version4Schema} UPDATE schema_version SET version=4 WHERE version=3; COMMIT;"); PruneMigrationBackups(4); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion4To5()
    {
        CreateMigrationBackup(5);
        try { Execute($"BEGIN IMMEDIATE; {Version5Schema} UPDATE schema_version SET version=5 WHERE version=4; COMMIT;"); PruneMigrationBackups(5); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion5To6()
    {
        CreateMigrationBackup(6);
        try { Execute($"BEGIN IMMEDIATE; {Version6Schema} UPDATE schema_version SET version=6 WHERE version=5; COMMIT;"); PruneMigrationBackups(6); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion6To7()
    {
        CreateMigrationBackup(7);
        try { Execute($"BEGIN IMMEDIATE; {Version7Schema} UPDATE schema_version SET version=7 WHERE version=6; COMMIT;"); PruneMigrationBackups(7); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion7To8()
    {
        CreateMigrationBackup(8);
        try { Execute($"BEGIN IMMEDIATE; {Version8Schema} UPDATE schema_version SET version=8 WHERE version=7; COMMIT;"); PruneMigrationBackups(8); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion8To9()
    {
        CreateMigrationBackup(9);
        try { Execute($"BEGIN IMMEDIATE; {Version9Schema} UPDATE schema_version SET version=9 WHERE version=8; COMMIT;"); PruneMigrationBackups(9); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion9To10()
    {
        CreateMigrationBackup(10);
        try { Execute($"BEGIN IMMEDIATE; {Version10Schema} UPDATE schema_version SET version=10 WHERE version=9; COMMIT;"); PruneMigrationBackups(10); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion10To11()
    {
        CreateMigrationBackup(11);
        try { Execute($"BEGIN IMMEDIATE; {Version11Schema} UPDATE schema_version SET version=11 WHERE version=10; COMMIT;"); PruneMigrationBackups(11); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion11To12()
    {
        CreateMigrationBackup(12);
        try { Execute($"BEGIN IMMEDIATE; {Version12Schema} UPDATE schema_version SET version=12 WHERE version=11; COMMIT;"); PruneMigrationBackups(12); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion12To13()
    {
        CreateMigrationBackup(13);
        try { Execute($"BEGIN IMMEDIATE; {Version13Schema} UPDATE schema_version SET version=13 WHERE version=12; COMMIT;"); PruneMigrationBackups(13); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion13To14()
    {
        CreateMigrationBackup(14);
        try { Execute($"BEGIN IMMEDIATE; {Version14Schema} UPDATE schema_version SET version=14 WHERE version=13; COMMIT;"); PruneMigrationBackups(14); }
        catch { TryRollback(); throw; }
    }

    /// Moves the flow off every observation row.
    ///
    /// The copy is checked before the original is dropped. A join cannot
    /// invent rows but it can drop them, and an observation whose flow had
    /// already been deleted would vanish silently -- on this machine that was
    /// none of 31,372,268, which is a fact about today and not a guarantee.
    /// Losing a row here would be losing a record of traffic, so the missing
    /// flows are rebuilt first and the count is compared afterwards.
    ///
    /// The comparison cannot be made to fire. Removing it breaks no test,
    /// which was checked rather than assumed, and it stays anyway: the
    /// rebuild above is what makes it unreachable, and if that ever stops
    /// covering a case, the failure it would let through is a record of
    /// traffic disappearing with the migration reporting success.
    /// Rewrites every observation's time as ticks.
    ///
    /// SQLite parses the stored text with julianday, which is a float and
    /// loses the hundred-nanosecond part -- P3-149 was that bug in the bucket
    /// arithmetic. So the conversion is done in two halves that are both
    /// exact: whole seconds from strftime, and the fraction read out of the
    /// text it is already in.
    /// Gives every folded hour a scope, and tells the truth about the old ones.
    ///
    /// Small: 11,732 rows on this machine against the 31 million v27 moved, so
    /// this is seconds rather than minutes. The backup is taken all the same --
    /// a cheap migration that goes wrong costs the same as an expensive one.
    private void MigrateVersion27To28()
    {
        CreateMigrationBackup(28);
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version28Schema);
            ReportMigration(28, MigrationProgress.MovingRows,
                ScalarInt64("SELECT COUNT(*) FROM chart_hourly"));
            // 'mixed', and no test reaches this line. A database has to hold
            // folded hours *and* be at v27 for it to matter, and the fixture
            // path cannot make one: a store always migrates to the current
            // version, and nothing folds during the chain. What the tests do
            // cover is everything downstream -- that a mixed hour is counted,
            // that a local one is not, and that the window says mixed hours
            // are present -- because SeedFoldedHourForTesting can write the
            // row this line would have written.
            Execute("""
                INSERT INTO chart_hourly_v28(bucket_start,application,layer,scope,
                  observation_count,flow_count,bytes_sent,bytes_received,bytes_unknown)
                SELECT bucket_start,application,layer,'mixed',
                       observation_count,flow_count,bytes_sent,bytes_received,bytes_unknown
                FROM chart_hourly;
                """);
            var before = ScalarInt64("SELECT COUNT(*) FROM chart_hourly");
            var after = ScalarInt64("SELECT COUNT(*) FROM chart_hourly_v28");
            if (before != after)
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid,
                    $"Scoping the folded hours would keep {after} of {before}.");
            Execute("""
                DROP TABLE chart_hourly;
                ALTER TABLE chart_hourly_v28 RENAME TO chart_hourly;
                CREATE INDEX IF NOT EXISTS chart_hourly_bucket ON chart_hourly(bucket_start);
                UPDATE schema_version SET version=28 WHERE version=27;
                COMMIT;
                """);
            PruneMigrationBackups(28);
        }
        catch { TryRollback(); throw; }
    }

    /// Flows that no observation refers to, carried across unchanged.
    ///
    /// Held here rather than inline so the plan check above and the statement
    /// that runs are the same text: a gate on a copy of a query is a gate on
    /// nothing.
    private const string FlowsWithoutObservations = """
                INSERT INTO flows_v29
                SELECT f.protocol||'|'||f.local_address||'|'||f.local_port||'|'||f.remote_address||'|'||f.remote_port||'|'||f.process_id||'|'||f.process_instance_id,
                       f.protocol,f.local_address,f.local_port,f.remote_address,f.remote_port,f.process_id,
                       f.first_seen,f.last_seen,f.origin,f.bytes_sent,f.bytes_received,f.layer,f.interface_id,
                       f.process_name,f.remote_hostname,f.process_instance_id
                FROM flows f WHERE NOT EXISTS(SELECT 1 FROM observations o WHERE o.flow_id=f.rowid)
                """;

    private void MigrateVersion28To29()
    {
        CreateMigrationBackup(29);
        EnsureFreeSpaceForCopy();
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version29Schema);
            // Old rows have no trustworthy process start time. Mark that fact
            // instead of manufacturing one; new observations never use this
            // namespace and therefore cannot merge into legacy ownership.
            Execute("UPDATE flows SET process_instance_id='legacy:pid:'||process_id||':name:'||COALESCE(process_name,'unknown')");
            Execute("UPDATE observations SET process_instance_id='legacy:pid:'||(SELECT process_id FROM flows WHERE flows.rowid=observations.flow_id)||':name:'||COALESCE(process_name,(SELECT process_name FROM flows WHERE flows.rowid=observations.flow_id),'unknown')");
            Execute("UPDATE delivery_queue SET process_instance_id='legacy:pid:'||process_id||':name:'||process_name");
            Execute("UPDATE delivery_queue SET stable_key=UPPER(protocol)||'|'||local_address||'|'||local_port||'|'||remote_address||'|'||remote_port||'|'||process_id||'|'||process_instance_id");
            ReportMigration(29, MigrationProgress.MovingRows, ScalarInt64("SELECT COUNT(*) FROM observations"));
            Execute("""
                CREATE TABLE flows_v29(
                  flow_key TEXT PRIMARY KEY, protocol TEXT NOT NULL, local_address TEXT NOT NULL,
                  local_port INTEGER NOT NULL, remote_address TEXT NOT NULL, remote_port INTEGER NOT NULL,
                  process_id INTEGER NOT NULL, first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
                  origin TEXT NOT NULL CHECK(origin IN ('snapshot','etw','both')), bytes_sent INTEGER,
                  bytes_received INTEGER, layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
                  interface_id TEXT, process_name TEXT, remote_hostname TEXT,
                  process_instance_id TEXT NOT NULL);
                CREATE TABLE observations_v29(
                  id INTEGER PRIMARY KEY, observed_at INTEGER NOT NULL, flow_id INTEGER NOT NULL,
                  remote_address TEXT NOT NULL, remote_port INTEGER NOT NULL, bytes_sent INTEGER,
                  bytes_received INTEGER, layer TEXT NOT NULL CHECK(layer IN ('logical','vpn_transport')),
                  source TEXT NOT NULL CHECK(source IN ('etw','snapshot')), process_name TEXT,
                  remote_hostname TEXT, process_instance_id TEXT NOT NULL);
                """);
            // observations.flow_id has never been indexed -- the only index
            // on the table is on observed_at -- and the anti-join below asks
            // "has this flow no observations?" once per flow. Without this
            // index that is a full scan of observations per row of flows.
            //
            // Measured on the machine this was written for: 650,325 flows
            // against 31,647,027 observations sat for 25 minutes reading
            // 1.2 TB, one core saturated, having written nothing since the
            // first statement. It was not slow. It was not going to finish.
            //
            // The index costs one sort of the table and is dropped with it
            // below, so nothing carries it into the new schema.
            Execute("CREATE INDEX IF NOT EXISTS observations_flow_id ON observations(flow_id)");
            // And a gate, because "too slow" is invisible in a test and
            // catastrophic on real data: refuse to run rather than discover
            // it on someone's machine after twenty-five minutes.
            //
            // Stated as "the index is used", not as "nothing is scanned".
            // The first attempt looked for "SCAN observations", which cannot
            // appear -- the table is aliased, so the plan says "SCAN o" -- and
            // a mutation run removed the index with the gate still passing.
            var plan = QueryPlan(FlowsWithoutObservations);
            if (!plan.Contains("observations_flow_id", StringComparison.Ordinal))
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid,
                    $"Finding flows without observations would not use the index: {plan}");

            // Raw observations still know UDP's real peer and the process
            // name at that instant. Split those rows instead of carrying the
            // old socket-only identity into the new schema.
            Execute("""
                INSERT INTO flows_v29(flow_key,protocol,local_address,local_port,remote_address,remote_port,
                  process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,
                  process_name,remote_hostname,process_instance_id)
                SELECT f.protocol||'|'||f.local_address||'|'||f.local_port||'|'||o.remote_address||'|'||o.remote_port||'|'||f.process_id||'|'||o.process_instance_id,
                       f.protocol,f.local_address,f.local_port,o.remote_address,o.remote_port,f.process_id,
                       f.first_seen,f.last_seen,f.origin,SUM(o.bytes_sent),SUM(o.bytes_received),
                       MIN(o.layer),f.interface_id,COALESCE(o.process_name,f.process_name),
                       MIN(COALESCE(o.remote_hostname,f.remote_hostname)),o.process_instance_id
                FROM observations o JOIN flows f ON f.rowid=o.flow_id
                GROUP BY f.protocol,f.local_address,f.local_port,o.remote_address,o.remote_port,
                         f.process_id,o.process_instance_id,COALESCE(o.process_name,f.process_name);
                """);
            Execute(FlowsWithoutObservations);
            Execute("""
                INSERT INTO observations_v29(id,observed_at,flow_id,remote_address,remote_port,bytes_sent,
                  bytes_received,layer,source,process_name,remote_hostname,process_instance_id)
                SELECT o.id,o.observed_at,n.rowid,o.remote_address,o.remote_port,o.bytes_sent,o.bytes_received,
                       o.layer,o.source,o.process_name,o.remote_hostname,o.process_instance_id
                FROM observations o JOIN flows f ON f.rowid=o.flow_id JOIN flows_v29 n
                  ON n.flow_key=f.protocol||'|'||f.local_address||'|'||f.local_port||'|'||o.remote_address||'|'||o.remote_port||'|'||f.process_id||'|'||o.process_instance_id;
                """);
            var before = ScalarInt64("SELECT COUNT(*) FROM observations");
            var after = ScalarInt64("SELECT COUNT(*) FROM observations_v29");
            if (before != after)
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid,
                    $"Separating process instances would keep {after} of {before} observations.");
            Execute("""
                DROP TABLE observations;
                DROP TABLE flows;
                ALTER TABLE flows_v29 RENAME TO flows;
                ALTER TABLE observations_v29 RENAME TO observations;
                CREATE INDEX flows_last_seen ON flows(last_seen);
                CREATE INDEX observations_observed_at ON observations(observed_at);
                """);
            Execute("UPDATE schema_version SET version=29 WHERE version=28");
            Execute("COMMIT");
            PruneMigrationBackups(29);
        }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion26To27()
    {
        CreateMigrationBackup(27);
        EnsureFreeSpaceForCopy();
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version27Schema);
            ReportMigration(27, MigrationProgress.MovingRows,
                ScalarInt64("SELECT COUNT(*) FROM observations"));
            Execute("""
                INSERT INTO observations_v27(id,observed_at,flow_id,remote_address,remote_port,
                  bytes_sent,bytes_received,layer,source,process_name,remote_hostname)
                SELECT id,
                       -- Position 21, not 20: 20 is the decimal point, and
                       -- ".4643757" casts to zero. Every row's fraction went
                       -- to nothing, which the round-trip check over all
                       -- 31,478,342 rows is the only reason anyone knows.
                       (CAST(strftime('%s',observed_at) AS INTEGER)+62135596800)*10000000
                         + CAST(substr(observed_at,21,7) AS INTEGER),
                       flow_id,remote_address,remote_port,
                       bytes_sent,bytes_received,layer,source,process_name,remote_hostname
                FROM observations;
                """);
            var before = ScalarInt64("SELECT COUNT(*) FROM observations");
            var after = ScalarInt64("SELECT COUNT(*) FROM observations_v27");
            if (before != after)
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid,
                    $"Converting observation times would keep {after} of {before} rows.");
            Execute("""
                DROP TABLE observations;
                ALTER TABLE observations_v27 RENAME TO observations;
                CREATE INDEX IF NOT EXISTS observations_observed_at ON observations(observed_at);
                UPDATE schema_version SET version=27 WHERE version=26;
                COMMIT;
                """);
            PruneMigrationBackups(27);
        }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion25To26()
    {
        CreateMigrationBackup(26);
        // Both tables exist at once in the middle of this, so the peak is the
        // database again on top of the backup. Rehearsed on the real file: a
        // 6.72 GiB database passed through 9.79 GiB of pages before the old
        // table was dropped. EnsureFreeSpaceForCopy has already asked for one
        // copy's worth for the backup; this asks for the other.
        EnsureFreeSpaceForCopy();
        try
        {
            Execute("BEGIN IMMEDIATE");
            Execute(Version26Schema);
            ReportMigration(26, MigrationProgress.MovingRows,
                ScalarInt64("SELECT COUNT(*) FROM observations"));
            // Flows arrived in v2. An observation older than that has nothing
            // to point at, and so does one whose flow retention removed first.
            //
            // Rebuilding it costs a grouped scan; refusing instead would turn
            // a database the Agent can still read into one it will not open,
            // which is a worse answer than a flow row reconstructed from the
            // rows that made it.
            Execute($"""
                INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,
                  process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,
                  process_name,remote_hostname)
                SELECT {LegacyFlowKey},o.protocol,o.local_address,o.local_port,
                       MIN(o.remote_address),MIN(o.remote_port),o.process_id,
                       MIN(o.observed_at),MAX(o.observed_at),'etw',
                       SUM(o.bytes_sent),SUM(o.bytes_received),
                       MIN(o.layer),MIN(o.interface_id),
                       MIN(o.process_name),MIN(o.remote_hostname)
                FROM observations o
                WHERE NOT EXISTS(SELECT 1 FROM flows f WHERE f.flow_key={LegacyFlowKey})
                GROUP BY {LegacyFlowKey},o.protocol,o.local_address,o.local_port,o.process_id;
                """);
            Execute($"""
                INSERT INTO observations_v26(id,observed_at,flow_id,remote_address,remote_port,
                  bytes_sent,bytes_received,layer,source,process_name,remote_hostname)
                SELECT o.id,o.observed_at,f.rowid,o.remote_address,o.remote_port,
                       o.bytes_sent,o.bytes_received,o.layer,o.source,o.process_name,o.remote_hostname
                FROM observations o JOIN flows f ON f.flow_key={LegacyFlowKey};
                """);
            var before = ScalarInt64("SELECT COUNT(*) FROM observations");
            var after = ScalarInt64("SELECT COUNT(*) FROM observations_v26");
            if (before != after)
                throw new ObservationStoreException(StoreFailureKind.SchemaInvalid,
                    $"Normalising observations would keep {after} of {before} rows; {before - after} have no flow to belong to.");
            Execute("""
                DROP TABLE observations;
                ALTER TABLE observations_v26 RENAME TO observations;
                CREATE INDEX IF NOT EXISTS observations_observed_at ON observations(observed_at);
                UPDATE schema_version SET version=26 WHERE version=25;
                COMMIT;
                """);
            PruneMigrationBackups(26);
        }
        catch { TryRollback(); throw; }
    }

    private string CreateMigrationBackup(int targetVersion)
    {
        var backup = $"{path}.pre-v{targetVersion}.bak";
        if (File.Exists(backup)) return backup;
        EnsureFreeSpaceForCopy();
        // Said before it starts, not after. On the machine this was measured
        // on the copy took fifteen seconds of the hundred and fifty, and a
        // reader watching nothing happen cannot tell which part they are in.
        ReportMigration(targetVersion, MigrationProgress.BackingUp, 0);
        Execute($"VACUUM INTO '{Sql(backup)}'");
        return backup;
    }

    /// Says the migration stopped, keeping what it was doing when it did.
    ///
    /// Read back rather than remembered, so the phase and the size in the
    /// report are the ones that were actually written: what the reader was
    /// last told is what they keep, with "failed" in front of it.
    private void ReportMigrationFailed(long currentVersion)
    {
        var last = MigrationProgress.Read(path);
        MigrationProgress.Write(path, new(
            last?.FromVersion ?? (int)currentVersion,
            last?.ToVersion ?? CurrentSchemaVersion,
            MigrationProgress.Failed, last?.Rows ?? 0, DateTimeOffset.UtcNow));
    }

    /// Writes down what this migration is doing, for a window that cannot ask.
    private void ReportMigration(int targetVersion, string phase, long rows)
    {
        var progress = new MigrationProgress(targetVersion - 1, targetVersion, phase, rows, DateTimeOffset.UtcNow);
        MigrationProgress.Write(path, progress);
        onMigration?.Invoke(progress);
    }

    private void EnsureFreeSpaceForCopy()
    {
        var databaseBytes = File.Exists(path) ? new FileInfo(path).Length : 0;
        var walPath = $"{path}-wal";
        var walBytes = File.Exists(walPath) ? new FileInfo(walPath).Length : 0;
        var required = checked(databaseBytes + walBytes + 64L * 1024 * 1024);
        var root = Path.GetPathRoot(path);
        if (string.IsNullOrWhiteSpace(root)) return;
        var available = new DriveInfo(root).AvailableFreeSpace;
        if (available < required)
            throw new ObservationStoreException(StoreFailureKind.DiskFull,
                $"Migration backup needs {required} bytes free but only {available} bytes are available.");
    }

    /// The default time a migration backup is kept once the migration it
    /// protects has already succeeded.
    ///
    /// A day is not a guess about when corruption appears. It is how long the
    /// Agent takes to exercise the new schema through everything it does:
    /// collection, delivery, the hourly fold, and the retention pass itself.
    /// A migration that broke any of those has shown it by then.
    public static readonly TimeSpan MigrationBackupProvingPeriod = TimeSpan.FromHours(24);

    /// Deletes migration backups whose migration has been proven.
    ///
    /// A backup exists so a broken migration can be undone, and nothing here
    /// ever deleted it afterwards -- the prune during a migration keeps the
    /// generation being written, so the file that survives is the one whose
    /// migration succeeded. On this machine that file is 7.32 GiB beside a
    /// 7.95 GiB database: the escape hatch costs as much as the thing it
    /// protects, and it is reported to the user as disk the Agent is using.
    ///
    /// The backup's own last-write time is the clock. Recording a migration
    /// time in the database would need a column, a column needs a schema
    /// version, and a schema version would take another full-size backup --
    /// the new state would cost more than the state it accounts for.
    ///
    /// There is no check here that the schema is current, because the store's
    /// own existence is that check: the constructor either reaches the current
    /// version or throws, so a failed migration leaves no object to call this
    /// on and no maintenance loop to call it from. A version comparison here
    /// would read like a safeguard while never being able to be false.
    public long PruneProvenMigrationBackups(DateTimeOffset now, TimeSpan? provingPeriod = null)
    {
        var period = provingPeriod ?? MigrationBackupProvingPeriod;
        if (period < TimeSpan.Zero) throw new ArgumentOutOfRangeException(nameof(provingPeriod));
        lock (gate) ThrowIfDisposed();

        var directory = Path.GetDirectoryName(path)!;
        var prefix = Path.GetFileName(path) + ".pre-v";
        long freed = 0;
        IEnumerable<string> candidates;
        try { candidates = Directory.EnumerateFiles(directory, prefix + "*.bak", SearchOption.TopDirectoryOnly).ToList(); }
        catch (IOException) { return 0; }
        catch (UnauthorizedAccessException) { return 0; }

        foreach (var candidate in candidates)
        {
            var name = Path.GetFileName(candidate);
            // Only the Agent's own naming. An operator's copy of the database
            // in the same directory is not ours to delete.
            if (!int.TryParse(name[prefix.Length..^4], out _)) continue;
            try
            {
                var info = new FileInfo(candidate);
                if (now - new DateTimeOffset(info.LastWriteTimeUtc, TimeSpan.Zero) < period) continue;
                var size = info.Length;
                File.Delete(candidate);
                freed = checked(freed + size);
            }
            // A backup that cannot be read or removed right now is left for
            // the next pass. Failing to reclaim disk is not a reason to fail
            // the maintenance that reclaims the rest of it.
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
        return freed;
    }

    private void PruneMigrationBackups(int keepTargetVersion)
    {
        var directory = Path.GetDirectoryName(path)!;
        var prefix = Path.GetFileName(path) + ".pre-v";
        foreach (var candidate in Directory.EnumerateFiles(directory, prefix + "*.bak", SearchOption.TopDirectoryOnly))
        {
            var name = Path.GetFileName(candidate);
            var versionText = name[prefix.Length..^4];
            if (!int.TryParse(versionText, out var version) || version == keepTargetVersion) continue;
            File.Delete(candidate);
        }
    }

    /// Checks the database before using it, at a depth that depends on how
    /// the last run ended.
    ///
    /// The full check reads every page. On this machine's 6.5 GB database that
    /// measured 26,567 ms of a 26,576 ms open -- everything else in the whole
    /// service startup came to 1.8 seconds -- and after a reboot, from a cold
    /// disk, it was over two minutes during which the Agent answered nothing
    /// and looked like it had not come back (P3-134).
    ///
    /// So the depth follows the risk. A run that said goodbye closed the
    /// database properly, and that is the case SQLite's durability is for: a
    /// structural quick check is enough. A run that was killed, crashed or
    /// faulted is the case where a torn write is actually plausible, and that
    /// one still pays for the full read. Speed is given up exactly where the
    /// doubt is.
    ///
    /// A full check is also forced when none has run for a week, so slow
    /// damage that no crash announced still surfaces without every boot paying
    /// for it.
    private void EnsureIntegrity()
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        if (!NeedsDeepIntegrityCheck())
        {
            // Nothing is read here at all.
            //
            // Making the check shallow was not enough: quick_check still reads
            // every page, and on a 7 GB database from a cold disk that
            // measured 118,649 ms -- against 26,567 ms for the full check when
            // the file was already in the page cache. The cost is the read,
            // not the depth, and no pragma avoids it.
            //
            // So when the last run said goodbye, the open trusts it and the
            // full check runs later, off the startup path. The Agent is
            // reachable in a second instead of two minutes, and the database
            // is still read in full -- just not while someone is waiting to
            // find out whether their agent came back.
            IntegrityCheckMilliseconds = 0;
            IntegrityCheckWasDeep = false;
            BackgroundIntegrityCheckDue = IsDeepIntegrityCheckOverdue();
            // Not "unverified". A full read did happen; it happened earlier,
            // and LastDeepIntegrityCheckAt says when. Throwing the answer away
            // at every open made the bundle report "unverified" beside a
            // timestamp -- two statements that cannot both be true.
            lastVerifiedIntegrity = LastDeepIntegrityCheckAtLocked() is null ? "unverified" : "ok";
            return;
        }
        var integrity = ScalarText("PRAGMA integrity_check");
        IntegrityCheckMilliseconds = timer.ElapsedMilliseconds;
        IntegrityCheckWasDeep = true;
        if (!string.Equals(integrity, "ok", StringComparison.Ordinal))
            throw new ObservationStoreException(StoreFailureKind.Corrupt, $"Database integrity check failed: {integrity}");
        lastVerifiedIntegrity = integrity;
        RecordDeepIntegrityCheck();
    }

    /// <remarks>
    /// Anything unreadable here answers yes. A missing table, an unparseable
    /// timestamp or a query that throws all mean the same thing -- that the
    /// last run cannot be shown to have ended cleanly -- and the safe reading
    /// of "cannot tell" is the slow one.
    /// </remarks>
    private bool NeedsDeepIntegrityCheck()
    {
        try
        {
            if (ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='run_history'") != 1) return true;
            var ending = ScalarText("SELECT ending FROM run_history WHERE component='service' ORDER BY id DESC LIMIT 1");
            if (ending is not ("clean" or "system-shutdown")) return true;
            if (ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='collector_counters'") != 1) return true;
            return false;
        }
        catch (Exception) { return true; }
    }

    /// Whether a full read is owed, without deciding when it happens.
    private bool IsDeepIntegrityCheckOverdue()
    {
        try
        {
            if (ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='collector_counters'") != 1) return true;
            var last = ScalarInt64("SELECT COALESCE((SELECT value FROM collector_counters WHERE name='integrity-deep-checked-at'),0)");
            return last <= 0 || DateTimeOffset.UtcNow - DateTimeOffset.FromUnixTimeSeconds(last) >= TimeSpan.FromDays(7);
        }
        catch (Exception) { return true; }
    }

    /// Whether a full read is owed but has not been done.
    public bool BackgroundIntegrityCheckDue { get; private set; }

    /// What the last full read found, and when it happened.
    ///
    /// Reported rather than recomputed. Running the check inside a request
    /// held the shared lock for thirty seconds, and the pipe serves one caller
    /// at a time, so saving a diagnostics bundle made the Agent unreachable --
    /// the window polls status every five seconds and showed "status
    /// unavailable" the whole time.
    public string LastVerifiedIntegrity { get { lock (gate) return lastVerifiedIntegrity; } }

    public DateTimeOffset? LastDeepIntegrityCheckAt { get { lock (gate) return LastDeepIntegrityCheckAtLocked(); } }

    private DateTimeOffset? LastDeepIntegrityCheckAtLocked()
    {
        try
        {
            var at = ScalarInt64("SELECT COALESCE((SELECT value FROM collector_counters WHERE name='integrity-deep-checked-at'),0)");
            return at > 0 ? DateTimeOffset.FromUnixTimeSeconds(at) : null;
        }
        catch (Exception) { return null; }
    }

    /// Reads every page on a connection of its own, so the rest of the Agent
    /// keeps working while it happens.
    ///
    /// A separate read-only connection rather than the shared one: the shared
    /// one is guarded by a lock that everything else waits on, and holding it
    /// for two minutes would be the startup pause again by another name. WAL
    /// lets a reader run beside the writer.
    ///
    /// <returns>The pragma's answer, or null when it could not be run.</returns>
    public string? VerifyIntegrityInBackground()
    {
        nint reader = 0;
        try
        {
            if (WinSqlite.Open(path, out reader, WinSqlite.OpenReadOnly | WinSqlite.OpenFullMutex, 0) != WinSqlite.Ok) return null;
            var answer = ScalarTextOn(reader, "PRAGMA integrity_check");
            if (!string.Equals(answer, "ok", StringComparison.Ordinal)) return answer;
            lock (gate)
            {
                RecordDeepIntegrityCheck();
                lastVerifiedIntegrity = "ok";
                BackgroundIntegrityCheckDue = false;
            }
            return "ok";
        }
        catch (Exception) { return null; }
        finally { if (reader != 0) WinSqlite.Close(reader); }
    }

    private static string? ScalarTextOn(nint connection, string sql)
    {
        if (WinSqlite.Prepare(connection, sql, -1, out var statement, 0) != WinSqlite.Ok) return null;
        try { return WinSqlite.Step(statement) == WinSqlite.Row ? Text(statement, 0) : null; }
        finally { WinSqlite.Finalize(statement); }
    }

    private void RecordDeepIntegrityCheck()
    {
        try
        {
            Execute($"INSERT INTO collector_counters(name,value) VALUES('integrity-deep-checked-at',{DateTimeOffset.UtcNow.ToUnixTimeSeconds()}) " +
                    "ON CONFLICT(name) DO UPDATE SET value=excluded.value");
        }
        catch (Exception) { /* Recording the check must not be what fails the open. */ }
    }

    private void MigrateVersion14To15()
    {
        CreateMigrationBackup(15);
        try { Execute($"BEGIN IMMEDIATE; {Version15Schema} UPDATE schema_version SET version=15 WHERE version=14; COMMIT;"); PruneMigrationBackups(15); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion15To16()
    {
        CreateMigrationBackup(16);
        try { Execute($"BEGIN IMMEDIATE; {Version16Schema} UPDATE schema_version SET version=16 WHERE version=15; COMMIT;"); PruneMigrationBackups(16); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion16To17()
    {
        CreateMigrationBackup(17);
        try { Execute($"BEGIN IMMEDIATE; {Version17Schema} UPDATE schema_version SET version=17 WHERE version=16; COMMIT;"); PruneMigrationBackups(17); }
        catch { TryRollback(); throw; }
    }

    private void MigrateVersion17To18()
    {
        CreateMigrationBackup(18);
        try { Execute($"BEGIN IMMEDIATE; {Version18Schema} UPDATE schema_version SET version=18 WHERE version=17; COMMIT;"); PruneMigrationBackups(18); }
        catch { TryRollback(); throw; }
    }

    private void ValidateSchema()
    {
        if (ScalarInt64("SELECT COUNT(*) FROM schema_version") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database must contain exactly one schema version row.");
        var tables = ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('schema_version','observations','collector_counters','flows','coverage_sessions','hourly_summary','delivery_queue','delivery_state','geo_locations','geo_cache_state','threat_indicators','threat_cache_state','chart_hourly','chart_hourly_destination','chart_hourly_state','local_history_settings','sleep_periods','run_history','outbound_traffic_windows','local_country_cache','geo_lookup_misses')");
        if (tables != 21)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is incomplete; refusing to recreate missing customer data tables.");
        var processNameColumns = ScalarInt64("SELECT (SELECT COUNT(*) FROM pragma_table_info('observations') WHERE name='process_name') + (SELECT COUNT(*) FROM pragma_table_info('flows') WHERE name='process_name')");
        if (processNameColumns != 2)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing process identity columns.");
        var hostnameColumns = ScalarInt64("SELECT (SELECT COUNT(*) FROM pragma_table_info('observations') WHERE name='remote_hostname') + (SELECT COUNT(*) FROM pragma_table_info('flows') WHERE name='remote_hostname')");
        if (hostnameColumns != 2)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing remote hostname columns.");
        var instanceColumns = ScalarInt64("SELECT (SELECT COUNT(*) FROM pragma_table_info('observations') WHERE name='process_instance_id') + (SELECT COUNT(*) FROM pragma_table_info('flows') WHERE name='process_instance_id') + (SELECT COUNT(*) FROM pragma_table_info('delivery_queue') WHERE name='process_instance_id')");
        if (instanceColumns != 3 || ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='startup_udp_placeholders'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing process-instance identity storage.");
        if (ScalarInt64("SELECT COUNT(*) FROM pragma_table_info('delivery_state') WHERE name='delivery_enabled'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing the delivery opt-in state.");
        if (ScalarInt64("SELECT COUNT(*) FROM pragma_table_info('delivery_queue') WHERE name='remote_hostname'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing the delivery hostname column.");
        if (ScalarInt64("SELECT COUNT(*) FROM pragma_table_info('coverage_sessions') WHERE name='confirmed_at'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing coverage confirmation timestamps.");
        if (ScalarInt64("SELECT COUNT(*) FROM pragma_table_info('coverage_sessions') WHERE name='interrupted'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema is missing coverage interruption state.");
        // The rebuild in v16 is the whole of that migration; if it were
        // skipped, writing a system shutdown would fail the CHECK at the one
        // moment the process has no time left to handle it.
        if (ScalarInt64("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='run_history' AND sql LIKE '%system-shutdown%'") != 1)
            throw new ObservationStoreException(StoreFailureKind.SchemaInvalid, "Database schema cannot record a system shutdown ending.");
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
                    INSERT INTO observations(observed_at,flow_id,remote_address,remote_port,
                      bytes_sent,bytes_received,layer,source,process_name,remote_hostname,process_instance_id)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?)
                    """;
                const string flowSql = """
                    INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,
                      process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,process_name,remote_hostname,process_instance_id)
                    VALUES(?,?,?,?,?,?,?,?,?,'etw',?,?,?,?,?,?,?)
                    ON CONFLICT(flow_key) DO UPDATE SET
                      -- The earliest and the latest, not the latest arrival.
                      -- Observations do not reach here in time order, and
                      -- assigning last_seen from whatever turned up last moved
                      -- it behind first_seen. See the v24 migration.
                      first_seen=MIN(flows.first_seen,excluded.first_seen),
                      last_seen=MAX(flows.last_seen,excluded.last_seen),
                      origin=CASE WHEN flows.origin='snapshot' THEN 'both' ELSE flows.origin END,
                      bytes_sent=CASE WHEN flows.bytes_sent IS NULL THEN excluded.bytes_sent ELSE flows.bytes_sent+excluded.bytes_sent END,
                      bytes_received=CASE WHEN flows.bytes_received IS NULL THEN excluded.bytes_received ELSE flows.bytes_received+excluded.bytes_received END,
                      layer=excluded.layer,
                      interface_id=COALESCE(excluded.interface_id,flows.interface_id),
                      process_name=COALESCE(excluded.process_name,flows.process_name),
                      remote_hostname=COALESCE(excluded.remote_hostname,flows.remote_hostname)
                    RETURNING rowid
                    """;
                Check(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                Check(WinSqlite.Prepare(db, flowSql, -1, out var flowStatement, 0));
                var summaries = new Dictionary<(string Bucket, string Protocol, string Layer), (long Count, long Sent, long Received, long Unknown)>();
                try
                {
                    foreach (var item in observations)
                    {
                        // The flow goes first now, because the observation
                        // needs the id it hands back.
                        var instanceId = item.ProcessInstanceId ?? $"legacy:pid:{item.ProcessId}:name:{item.ProcessName ?? "unknown"}";
                        Bind(flowStatement, 1, StartupSnapshot.FlowKey(item.Protocol, item.LocalAddress, item.LocalPort, item.RemoteAddress, item.RemotePort, item.ProcessId, instanceId));
                        Bind(flowStatement, 2, item.Protocol); Bind(flowStatement, 3, item.LocalAddress);
                        Check(WinSqlite.BindInt64(flowStatement, 4, item.LocalPort)); Bind(flowStatement, 5, item.RemoteAddress);
                        Check(WinSqlite.BindInt64(flowStatement, 6, item.RemotePort)); Check(WinSqlite.BindInt64(flowStatement, 7, item.ProcessId));
                        Bind(flowStatement, 8, item.ObservedAt.ToUniversalTime().ToString("O")); Bind(flowStatement, 9, item.ObservedAt.ToUniversalTime().ToString("O"));
                        BindNullable(flowStatement, 10, item.BytesSent); BindNullable(flowStatement, 11, item.BytesReceived);
                        Bind(flowStatement, 12, item.Layer == ObservationLayer.Logical ? "logical" : "vpn_transport"); BindNullable(flowStatement, 13, item.InterfaceId);
                        BindNullable(flowStatement, 14, item.ProcessName);
                        BindNullable(flowStatement, 15, NormalizeDomain(item.RemoteHostname));
                        Bind(flowStatement, 16, instanceId);
                        CheckQueryRow(WinSqlite.Step(flowStatement));
                        var flowId = WinSqlite.ColumnInt64(flowStatement, 0);
                        CheckDone(WinSqlite.Step(flowStatement));
                        Check(WinSqlite.Reset(flowStatement)); Check(WinSqlite.ClearBindings(flowStatement));
                        Check(WinSqlite.BindInt64(statement, 1, item.ObservedAt.ToUniversalTime().UtcTicks));
                        Check(WinSqlite.BindInt64(statement, 2, flowId));
                        Bind(statement, 3, item.RemoteAddress);
                        Check(WinSqlite.BindInt64(statement, 4, item.RemotePort));
                        BindNullable(statement, 5, item.BytesSent);
                        BindNullable(statement, 6, item.BytesReceived);
                        Bind(statement, 7, item.Layer == ObservationLayer.Logical ? "logical" : "vpn_transport");
                        Bind(statement, 8, item.Source);
                        BindNullable(statement, 9, item.ProcessName);
                        BindNullable(statement, 10, NormalizeDomain(item.RemoteHostname));
                        Bind(statement, 11, instanceId);
                        CheckDone(WinSqlite.Step(statement));
                        Check(WinSqlite.Reset(statement));
                        Check(WinSqlite.ClearBindings(statement));
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

    public RetentionMaintenanceResult PruneRetentionBatch(DateTimeOffset now, int batchSize = 50_000)
    {
        if (batchSize is < 1 or > 250_000) throw new ArgumentOutOfRangeException(nameof(batchSize));
        lock (gate)
        {
            ThrowIfDisposed();
            var retentionDays = (int)ScalarInt64("SELECT retention_days FROM local_history_settings WHERE id=1");
            var rawDays = Math.Min(DefaultRawRetentionDays, retentionDays);
            var rawCutoff = now.ToUniversalTime().AddDays(-rawDays).ToString("O");
            var rawCutoffTicks = now.ToUniversalTime().AddDays(-rawDays).UtcTicks;
            var aggregateCutoff = now.ToUniversalTime().AddDays(-retentionDays).ToString("O");
            Execute("BEGIN IMMEDIATE");
            try
            {
                var observations = DeleteBatchAt("observations", "id", "observed_at", rawCutoffTicks, batchSize);
                var flows = DeleteBatch("flows", "flow_key", "last_seen", rawCutoff, batchSize);
                var summaries = DeleteBatch("hourly_summary", "rowid", "bucket_start", aggregateCutoff, batchSize);
                var chartSummaries = DeleteBatch("chart_hourly", "rowid", "bucket_start", aggregateCutoff, batchSize)
                    + DeleteBatch("chart_hourly_destination", "rowid", "bucket_start", aggregateCutoff, batchSize);
                var coverage = DeleteBatch("coverage_sessions", "id", "COALESCE(ended_at,started_at)", aggregateCutoff, batchSize);
                var sleeps = DeleteBatch("sleep_periods", "id", "COALESCE(ended_at,started_at)", aggregateCutoff, batchSize);
                Execute("COMMIT");
                return new(observations, flows, summaries, coverage, chartSummaries, sleeps);
            }
            catch
            {
                TryRollback();
                throw;
            }
        }
    }

    public LocalHistoryStatus ReadLocalHistoryStatus(DateTimeOffset now)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            var retentionDays = (int)ScalarInt64("SELECT retention_days FROM local_history_settings WHERE id=1");
            var lastText = NullableScalarText("SELECT last_cleanup_at FROM local_history_settings WHERE id=1");
            // Two tables, two representations: observations count in ticks and
        // flows still in text. Asking each its own way is clearer than a
        // union that has to agree on one.
        var oldestObservation = OldestObservation();
        var oldestFlowText = NullableScalarText("SELECT MIN(last_seen) FROM flows");
        var oldestFlow = oldestFlowText is null ? (DateTimeOffset?)null : DateTimeOffset.Parse(oldestFlowText);
        var oldestRaw2 = (oldestObservation, oldestFlow) switch
        {
            ({ } a, { } b) => a < b ? a : (DateTimeOffset?)b,
            ({ } a, null) => a,
            (null, { } b) => b,
            _ => null,
        };
        var oldestRawText = oldestRaw2?.ToString("O");
            var oldestAggregateText = NullableScalarText("SELECT MIN(value) FROM (SELECT MIN(bucket_start) value FROM hourly_summary UNION ALL SELECT MIN(bucket_start) FROM chart_hourly)");
            DateTimeOffset? last = lastText is null ? null : DateTimeOffset.Parse(lastText);
            return new(retentionDays, Math.Min(DefaultRawRetentionDays, retentionDays), ReadStorageBytes(),
                oldestRawText is null ? null : DateTimeOffset.Parse(oldestRawText),
                oldestAggregateText is null ? null : DateTimeOffset.Parse(oldestAggregateText),
                last, last?.AddHours(24) ?? now.ToUniversalTime());
        }
    }

    public void SetRetentionDays(int days)
    {
        if (!AllowedRetentionDays.Contains(days)) throw new ArgumentOutOfRangeException(nameof(days));
        lock (gate)
        {
            ThrowIfDisposed();
            Execute($"UPDATE local_history_settings SET retention_days={days} WHERE id=1");
        }
    }

    public void MarkRetentionMaintenanceCompleted(DateTimeOffset completedAt)
    {
        lock (gate) Execute($"UPDATE local_history_settings SET last_cleanup_at='{completedAt.ToUniversalTime():O}' WHERE id=1");
    }

    public IReadOnlyList<RecentFlow> ReadHistoryForExport(DateTimeOffset? before, int limit, int offset)
    {
        if (limit is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(limit));
        if (offset is < 0 or > 10_000_000) throw new ArgumentOutOfRangeException(nameof(offset));
        lock (gate)
        {
            const string columns = "f.first_seen,f.last_seen,f.protocol,f.local_address,f.local_port,f.remote_address,f.remote_port,f.process_id,f.process_name,f.bytes_sent,f.bytes_received,f.layer,f.interface_id,f.origin,f.remote_hostname,COALESCE(g.country_code,lc.country_code),f.process_instance_id";
            var cutoff = before is null ? string.Empty : $"WHERE f.last_seen<'{Sql(before.Value.ToUniversalTime().ToString("O"))}'";
            var sql = $"SELECT {columns} FROM flows f LEFT JOIN geo_locations g ON g.ip=f.remote_address LEFT JOIN local_country_cache lc ON lc.ip=f.remote_address {cutoff} ORDER BY f.last_seen DESC,f.flow_key LIMIT {limit} OFFSET {offset}";
            return ReadRecentFlowQuery(sql);
        }
    }

    public LocalHistoryDeletionResult DeleteLocalHistory(DateTimeOffset? before, DateTimeOffset now)
    {
        var cutoff = (before ?? now).ToUniversalTime();
        if (cutoff > now.ToUniversalTime().AddMinutes(5)) throw new ArgumentOutOfRangeException(nameof(before));
        lock (gate)
        {
            ThrowIfDisposed();
            Execute("BEGIN IMMEDIATE");
            try
            {
                long observations;
                long flows;
                long hourly;
                long chart;
                long coverage;
                long sleeps;
                if (before is null)
                {
                    var result = DeleteLocalHistoryWithinTransaction(cutoff);
                    observations = result.ObservationsDeleted;
                    flows = result.FlowsDeleted;
                    hourly = result.HourlySummariesDeleted;
                    chart = result.ChartSummariesDeleted;
                    coverage = result.CoverageSessionsDeleted;
                    sleeps = result.SleepPeriodsDeleted;
                }
                else
                {
                    var value = Sql(cutoff.ToString("O"));
                    observations = DeleteWhere("observations", $"observed_at<{DateTimeOffset.Parse(value).UtcTicks}");
                    flows = DeleteWhere("flows", $"last_seen<'{value}'");
                    hourly = DeleteWhere("hourly_summary", $"bucket_start<'{value}'");
                    chart = DeleteWhere("chart_hourly", $"bucket_start<'{value}'")
                        + DeleteWhere("chart_hourly_destination", $"bucket_start<'{value}'");
                    coverage = DeleteMatchingCoverage($"ended_at IS NOT NULL AND ended_at<'{value}'");
                    Execute($"UPDATE coverage_sessions SET started_at='{value}' WHERE started_at<'{value}' AND (ended_at IS NULL OR ended_at>='{value}')");
                    sleeps = DeleteWhere("sleep_periods", $"ended_at IS NOT NULL AND ended_at<'{value}'");
                    Execute($"UPDATE sleep_periods SET started_at='{value}' WHERE started_at<'{value}' AND (ended_at IS NULL OR ended_at>='{value}')");
                    RefoldDeletionBoundary(cutoff);
                }
                Execute("COMMIT");
                return new(observations, flows, hourly, chart, coverage, sleeps);
            }
            catch
            {
                TryRollback();
                throw;
            }
        }
    }

    private LocalHistoryDeletionResult DeleteLocalHistoryWithinTransaction(DateTimeOffset cutoff)
    {
        var observations = DeleteAllRows("observations");
        var flows = DeleteAllRows("flows");
        var hourly = DeleteAllRows("hourly_summary");
        var chart = DeleteAllRows("chart_hourly") + DeleteAllRows("chart_hourly_destination");
        Execute("DELETE FROM chart_hourly_state");
        var coverage = DeleteMatchingCoverage("ended_at IS NOT NULL");
        Execute($"UPDATE coverage_sessions SET started_at='{cutoff:O}',confirmed_at='{cutoff:O}' WHERE ended_at IS NULL");
        var sleeps = DeleteWhere("sleep_periods", "ended_at IS NOT NULL");
        Execute($"UPDATE sleep_periods SET started_at='{cutoff:O}' WHERE ended_at IS NULL");
        return new(observations, flows, hourly, chart, coverage, sleeps);
    }

    private long DeleteAllRows(string table) => DeleteWhere(table, "1=1");

    private long DeleteMatchingCoverage(string condition) => DeleteWhere("coverage_sessions", condition);

    private long DeleteWhere(string table, string condition)
    {
        Execute($"DELETE FROM {table} WHERE {condition}");
        return ScalarInt64("SELECT changes()");
    }

    private void RefoldDeletionBoundary(DateTimeOffset cutoff)
    {
        var boundary = new DateTimeOffset(cutoff.Year, cutoff.Month, cutoff.Day, cutoff.Hour, 0, 0, TimeSpan.Zero);
        if (boundary == cutoff) return;
        var end = boundary.AddHours(1);
        var foldedThrough = NullableScalarText("SELECT folded_through FROM chart_hourly_state WHERE id=1");
        if (foldedThrough is null || DateTimeOffset.Parse(foldedThrough) <= boundary) return;
        Execute($"""
            INSERT INTO hourly_summary(bucket_start,protocol,layer,observation_count,bytes_sent,bytes_received,bytes_unknown)
            SELECT '{boundary:O}',f.protocol,layer,COUNT(*),SUM(COALESCE(bytes_sent,0)),SUM(COALESCE(bytes_received,0)),
                   SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
            FROM observations o JOIN flows f ON f.rowid=o.flow_id
            WHERE observed_at>={cutoff.UtcTicks} AND observed_at<{end.UtcTicks} GROUP BY f.protocol,layer;
            INSERT INTO chart_hourly(bucket_start,application,layer,scope,observation_count,bytes_sent,bytes_received,bytes_unknown)
            SELECT '{boundary:O}',COALESCE(NULLIF(process_name,''),'Unknown'),layer,{ObservedScope},COUNT(*),
                   SUM(COALESCE(bytes_sent,0)),SUM(COALESCE(bytes_received,0)),
                   SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
            FROM observations WHERE observed_at>={cutoff.UtcTicks} AND observed_at<{end.UtcTicks} GROUP BY 2,layer,4;
            """);
    }

    public bool CompactIfBeneficial(double minimumFreeFraction = 0.20)
    {
        if (minimumFreeFraction is <= 0 or >= 1) throw new ArgumentOutOfRangeException(nameof(minimumFreeFraction));
        lock (gate)
        {
            ThrowIfDisposed();
            var pages = ScalarInt64("PRAGMA page_count");
            var free = ScalarInt64("PRAGMA freelist_count");
            if (pages == 0 || free < pages * minimumFreeFraction) return false;
            EnsureFreeSpaceForCopy();
            Execute("PRAGMA wal_checkpoint(TRUNCATE)");
            Execute("VACUUM");
            return true;
        }
    }

    /// The oldest observation, or null when there are none.
    private DateTimeOffset? OldestObservation()
    {
        var ticks = NullableScalarText("SELECT MIN(observed_at) FROM observations");
        return ticks is null ? null : new DateTimeOffset(long.Parse(ticks, System.Globalization.CultureInfo.InvariantCulture), TimeSpan.Zero);
    }

    /// The same batched delete, for a column counting in ticks rather than
    /// spelling a date. One template with a quoted literal cannot serve both,
    /// and quoting a number is how an index stops being used.
    private long DeleteBatchAt(string table, string key, string timeExpression, long cutoff, int batchSize)
    {
        Execute($"DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} WHERE {timeExpression}<{cutoff} ORDER BY {timeExpression} LIMIT {batchSize})");
        return ScalarInt64("SELECT changes()");
    }

    private long DeleteBatch(string table, string key, string timeExpression, string cutoff, int batchSize)
    {
        Execute($"DELETE FROM {table} WHERE {key} IN (SELECT {key} FROM {table} WHERE {timeExpression}<'{Sql(cutoff)}' ORDER BY {timeExpression} LIMIT {batchSize})");
        return ScalarInt64("SELECT changes()");
    }

    public long BeginCoverage(IReadOnlyList<StartupFlow> snapshot, DateTimeOffset startedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                // A prior process may have been killed before EndCoverage. Its
                // last heartbeat is the last instant we can honestly claim;
                // never extend that abandoned session to this new start.
                Execute("UPDATE coverage_sessions SET ended_at=COALESCE(confirmed_at,started_at),interrupted=1 WHERE ended_at IS NULL");
                Execute($"INSERT INTO coverage_sessions(started_at,confirmed_at,snapshot_count) VALUES('{startedAt:O}','{startedAt:O}',{snapshot.Count})");
                var id = ScalarInt64("SELECT last_insert_rowid()");
                foreach (var flow in snapshot)
                {
                    var instanceId = flow.ProcessInstanceId ?? $"legacy:pid:{flow.ProcessId}:name:{flow.ProcessName ?? "unknown"}";
                    var processName = flow.ProcessName is null ? "NULL" : $"'{Sql(flow.ProcessName)}'";
                    if (flow.Protocol == "UDP" && string.IsNullOrEmpty(flow.RemoteAddress))
                    {
                        Execute($"INSERT INTO startup_udp_placeholders(coverage_id,local_address,local_port,process_id,process_name,process_instance_id) VALUES({id},'{Sql(flow.LocalAddress)}',{flow.LocalPort},{flow.ProcessId},{processName},'{Sql(instanceId)}')");
                        continue;
                    }
                    var key = StartupSnapshot.FlowKey(flow.Protocol, flow.LocalAddress, flow.LocalPort, flow.RemoteAddress, flow.RemotePort, flow.ProcessId, instanceId).Replace("'", "''", StringComparison.Ordinal);
                    Execute($"INSERT INTO flows(flow_key,protocol,local_address,local_port,remote_address,remote_port,process_id,first_seen,last_seen,origin,bytes_sent,bytes_received,layer,interface_id,process_name,remote_hostname,process_instance_id) VALUES('{key}','{flow.Protocol}','{flow.LocalAddress}',{flow.LocalPort},'{flow.RemoteAddress}',{flow.RemotePort},{flow.ProcessId},'{startedAt:O}','{startedAt:O}','snapshot',NULL,NULL,'logical',NULL,{processName},NULL,'{Sql(instanceId)}') ON CONFLICT(flow_key) DO NOTHING");
                }
                Execute("COMMIT");
                return id;
            }
            catch { TryRollback(); throw; }
        }
    }

    public void EndCoverage(long id, DateTimeOffset endedAt)
    {
        lock (gate) Execute($"UPDATE coverage_sessions SET confirmed_at='{endedAt:O}',ended_at='{endedAt:O}' WHERE id={id} AND ended_at IS NULL");
    }

    public void ConfirmCoverage(long id, DateTimeOffset confirmedAt)
    {
        lock (gate) Execute($"UPDATE coverage_sessions SET confirmed_at='{confirmedAt:O}' WHERE id={id} AND ended_at IS NULL");
    }

    public void InterruptCoverage(long id, DateTimeOffset lastConfirmedAt)
    {
        lock (gate) Execute($"UPDATE coverage_sessions SET confirmed_at='{lastConfirmedAt:O}',ended_at='{lastConfirmedAt:O}',interrupted=1 WHERE id={id} AND ended_at IS NULL");
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
            ScalarInt64("SELECT COUNT(*) FROM coverage_sessions WHERE interrupted=1"));
    }

    public void BeginSleepPeriod(DateTimeOffset at)
    {
        lock (gate)
        {
            var value = at.ToUniversalTime().ToString("O");
            Execute($"BEGIN IMMEDIATE; UPDATE sleep_periods SET ended_at='{value}' WHERE ended_at IS NULL; INSERT INTO sleep_periods(started_at) VALUES('{value}'); COMMIT;");
        }
    }

    public void EndSleepPeriod(DateTimeOffset at)
    {
        lock (gate) Execute($"UPDATE sleep_periods SET ended_at='{at.ToUniversalTime():O}' WHERE ended_at IS NULL");
    }

    public IReadOnlyList<SleepPeriod> ReadSleepPeriods(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate) return ReadSleepPeriodsLocked(from, to);
    }

    private IReadOnlyList<SleepPeriod> ReadSleepPeriodsLocked(DateTimeOffset from, DateTimeOffset to)
    {
        {
            var result = new List<SleepPeriod>();
            var sql = $"SELECT started_at,COALESCE(ended_at,'{to.ToUniversalTime():O}') FROM sleep_periods WHERE started_at<'{to.ToUniversalTime():O}' AND COALESCE(ended_at,'{to.ToUniversalTime():O}')>'{from.ToUniversalTime():O}' ORDER BY started_at";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            try
            {
                while (WinSqlite.Step(statement) == WinSqlite.Row)
                {
                    var start = DateTimeOffset.Parse(Text(statement, 0));
                    var end = DateTimeOffset.Parse(Text(statement, 1));
                    result.Add(new(start < from ? from : start, end > to ? to : end));
                }
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
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

    /// Open a run, and settle what happened to the last one.
    ///
    /// A crashed process writes nothing, so the previous run's fate has to be
    /// decided here, by the next start: a row still marked running when a new
    /// run begins is a run that never got to say goodbye. Its end is recorded
    /// as its last heartbeat rather than as now -- claiming it ran until this
    /// moment would invent the whole gap.
    public long BeginRun(RunComponent component, string version)
    {
        var name = component == RunComponent.Service ? "service" : "ui";
        lock (gate)
        {
            Execute($"UPDATE run_history SET ending='unexpected',ended_at=COALESCE(heartbeat_at,started_at) " +
                $"WHERE component='{name}' AND ending='running'");
            // A window whose run began before this service did is not running:
            // the service restarting means the machine or the install changed
            // under it. Only the window can settle its own run, and a window
            // that never comes back would leave the row marked running for
            // ever -- saying a dead process is alive, which is worse than
            // saying nothing.
            if (component == RunComponent.Service)
                Execute($"UPDATE run_history SET ending='unexpected',ended_at=COALESCE(heartbeat_at,started_at) " +
                    $"WHERE component='ui' AND ending='running' AND started_at < '{DateTimeOffset.UtcNow:O}'");
            Execute($"INSERT INTO run_history(component,version,started_at,heartbeat_at,ending) " +
                $"VALUES('{name}','{Sql(Trim(version, 64))}','{DateTimeOffset.UtcNow:O}','{DateTimeOffset.UtcNow:O}','running')");
            var id = ScalarInt64("SELECT last_insert_rowid()");
            // Bounded: a machine that restarts often must not turn its own
            // history into the thing that fills the disk.
            Execute($"DELETE FROM run_history WHERE component='{name}' AND id<=(SELECT MIN(id) FROM (SELECT id FROM run_history WHERE component='{name}' ORDER BY id DESC LIMIT 50))-1");
            return id;
        }
    }

    public void Heartbeat(long runId)
    {
        lock (gate) Execute($"UPDATE run_history SET heartbeat_at='{DateTimeOffset.UtcNow:O}' WHERE id={runId} AND ending='running'");
    }

    public void EndRun(long runId)
    {
        lock (gate) Execute($"UPDATE run_history SET ending='clean',ended_at='{DateTimeOffset.UtcNow:O}' WHERE id={runId} AND ending='running'");
    }

    /// Windows tells a service when the machine itself is going down, and the
    /// grace it gives afterwards is short enough that the process is often
    /// killed before it can finish. Recording the ending on notification, not
    /// on completion, is what makes the difference survive being killed.
    ///
    /// This deliberately wins over <see cref="EndRun"/>: a stop that drained
    /// cleanly on the way down is still a stop the machine chose, and that is
    /// the thing worth counting separately. A run that is never notified stays
    /// "unexpected" -- the notification is evidence, and its absence is not
    /// evidence of the opposite.
    public void EndSystemShutdownRun(long runId)
    {
        lock (gate) Execute($"UPDATE run_history SET ending='system-shutdown',ended_at='{DateTimeOffset.UtcNow:O}' WHERE id={runId} AND ending='running'");
    }

    /// <param name="faultType">
    /// The exception's type name and nothing else. A message can carry a file
    /// path with the account name in it, a host name, or a destination, and
    /// the diagnostics bundle promises to carry none of those. The type is
    /// what distinguishes one crash from another anyway.
    /// </param>
    public void FaultRun(long runId, string faultType)
    {
        lock (gate) Execute($"UPDATE run_history SET ending='faulted',ended_at='{DateTimeOffset.UtcNow:O}'," +
            $"fault='{Sql(SafeTypeName(faultType))}' WHERE id={runId} AND ending='running'");
    }

    /// Captures the last completed fifteen-minute window and returns the seven
    /// days before it. A window this run or an earlier one already captured
    /// returns null, so a restart cannot raise the same alert twice.
    public (OutboundTrafficWindow Current, IReadOnlyList<OutboundTrafficWindow> Baseline)? CaptureOutboundTrafficWindow(DateTimeOffset now)
    {
        var duration = TimeSpan.FromMinutes(15);
        var end = new DateTimeOffset(now.UtcTicks - now.UtcTicks % duration.Ticks, TimeSpan.Zero);
        var start = end - duration;
        lock (gate)
        {
            if (ScalarInt64($"SELECT COUNT(*) FROM outbound_traffic_windows WHERE window_start='{start:O}'") != 0) return null;
            Execute("BEGIN IMMEDIATE;");
            try
            {
                var current = ReadOutboundWindow(start, end);
                Execute("INSERT INTO outbound_traffic_windows(window_start,bytes_out,observation_count," +
                    "observations_with_bytes,application_count,destination_count,largest_application_bytes_out) " +
                    $"VALUES('{start:O}',{current.BytesOut},{current.ObservationCount},{current.ObservationsWithBytes}," +
                    $"{current.ApplicationCount},{current.DestinationCount},{current.LargestApplicationBytesOut});");
                var cutoff = start - TimeSpan.FromDays(7);
                var baseline = ReadOutboundWindows(cutoff, start);
                Execute($"DELETE FROM outbound_traffic_windows WHERE window_start < '{cutoff:O}';");
                Execute("COMMIT;");
                return (current, baseline);
            }
            catch { TryRollback(); throw; }
        }
    }

    /// Byte counts arrive only when a flow reports its final statistics, so
    /// observations_with_bytes is counted separately from observations: a
    /// window nobody could measure must not read as a quiet one.
    private OutboundTrafficWindow ReadOutboundWindow(DateTimeOffset start, DateTimeOffset end)
    {
        var range = $"WHERE observed_at >= {start.UtcTicks} AND observed_at < {end.UtcTicks}";
        ulong bytesOut = 0; var observations = 0; var withBytes = 0; var applications = 0; var destinations = 0;
        CheckOperation(WinSqlite.Prepare(db, "SELECT COALESCE(SUM(bytes_sent),0), COUNT(*), COUNT(bytes_sent), " +
            $"COUNT(DISTINCT COALESCE(process_name,'')), COUNT(DISTINCT remote_address) FROM observations {range}", -1, out var summary, 0));
        try
        {
            if (WinSqlite.Step(summary) == WinSqlite.Row)
            {
                bytesOut = (ulong)Math.Max(0, WinSqlite.ColumnInt64(summary, 0));
                observations = (int)WinSqlite.ColumnInt64(summary, 1);
                withBytes = (int)WinSqlite.ColumnInt64(summary, 2);
                applications = (int)WinSqlite.ColumnInt64(summary, 3);
                destinations = (int)WinSqlite.ColumnInt64(summary, 4);
            }
        }
        finally { WinSqlite.Finalize(summary); }

        var largest = (ulong)Math.Max(0, ScalarInt64("SELECT COALESCE(MAX(app_bytes),0) FROM (SELECT SUM(COALESCE(bytes_sent,0)) " +
            $"AS app_bytes FROM observations {range} GROUP BY COALESCE(process_name,''))"));
        return new OutboundTrafficWindow(start, bytesOut, observations, withBytes, applications, destinations, largest);
    }

    private IReadOnlyList<OutboundTrafficWindow> ReadOutboundWindows(DateTimeOffset from, DateTimeOffset before)
    {
        CheckOperation(WinSqlite.Prepare(db, "SELECT window_start,bytes_out,observation_count,observations_with_bytes," +
            "application_count,destination_count,largest_application_bytes_out FROM outbound_traffic_windows " +
            $"WHERE window_start >= '{from:O}' AND window_start < '{before:O}' ORDER BY window_start", -1, out var statement, 0));
        var result = new List<OutboundTrafficWindow>();
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
                result.Add(new OutboundTrafficWindow(
                    DateTimeOffset.Parse(Text(statement, 0)),
                    (ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 1)),
                    (int)WinSqlite.ColumnInt64(statement, 2), (int)WinSqlite.ColumnInt64(statement, 3),
                    (int)WinSqlite.ColumnInt64(statement, 4), (int)WinSqlite.ColumnInt64(statement, 5),
                    (ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 6))));
        }
        finally { WinSqlite.Finalize(statement); }
        return result;
    }

    public void RecordOutboundAnomaly(DateTimeOffset windowStart, OutboundAnomalyKind kind)
    {
        var name = kind == OutboundAnomalyKind.DistributedTransfer ? "distributed-transfer" : "large-transfer";
        lock (gate) Execute($"UPDATE outbound_traffic_windows SET anomaly_kind='{name}' WHERE window_start='{windowStart:O}'");
    }

    /// The newest window that was judged unusual, so the window can notice a
    /// new one rather than a count that says only how many there have been.
    public (DateTimeOffset WindowStart, OutboundAnomalyKind Kind, ulong BytesOut)? ReadLatestOutboundAnomaly()
    {
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, "SELECT window_start,anomaly_kind,bytes_out FROM outbound_traffic_windows " +
                "WHERE anomaly_kind IS NOT NULL ORDER BY window_start DESC LIMIT 1", -1, out var statement, 0));
            try
            {
                if (WinSqlite.Step(statement) != WinSqlite.Row) return null;
                return (DateTimeOffset.Parse(Text(statement, 0)),
                    Text(statement, 1) == "distributed-transfer" ? OutboundAnomalyKind.DistributedTransfer : OutboundAnomalyKind.LargeTransfer,
                    (ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 2)));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    public int ReadOutboundAnomalyCount(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate) return ReadOutboundAnomalyCountLocked(from, to);
    }

    /// The lock in this class is not reentrant, so the version called from
    /// inside an existing hold must not take it again.
    /// Counted with the same coverage gate the detector applies, so the screen
    /// and the detector agree about whether there is a baseline. A row whose
    /// bytes were never measured is not evidence of a quiet fifteen minutes.
    private int ReadUsableBaselineWindowsLocked() => (int)ScalarInt64(
        "SELECT COUNT(*) FROM outbound_traffic_windows WHERE observation_count >= 10 " +
        "AND observations_with_bytes * 10 >= observation_count * 8");

    private int ReadOutboundAnomalyCountLocked(DateTimeOffset from, DateTimeOffset to) => (int)ScalarInt64("SELECT COUNT(*) FROM outbound_traffic_windows " +
            $"WHERE window_start >= '{from:O}' AND window_start < '{to:O}' AND anomaly_kind IS NOT NULL");

    public IReadOnlyList<AgentRun> ReadRunHistory(int limit = 20)
    {
        if (limit is < 1 or > 200) throw new ArgumentOutOfRangeException(nameof(limit));
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, $"SELECT component,version,started_at,heartbeat_at,ended_at,ending,fault FROM run_history ORDER BY id DESC LIMIT {limit}", -1, out var statement, 0));
            var result = new List<AgentRun>();
            try
            {
                while (WinSqlite.Step(statement) == WinSqlite.Row)
                    result.Add(new AgentRun(
                        Text(statement, 0) == "service" ? RunComponent.Service : RunComponent.Ui,
                        Text(statement, 1), DateTimeOffset.Parse(Text(statement, 2)),
                        Parse(NullableTextValue(statement, 3)), Parse(NullableTextValue(statement, 4)),
                        Text(statement, 5), NullableTextValue(statement, 6)));
            }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    private static DateTimeOffset? Parse(string? value) =>
        value is null ? null : DateTimeOffset.TryParse(value, out var parsed) ? parsed : null;

    private static string Trim(string value, int length) =>
        value.Length <= length ? value : value[..length];

    /// The leading type name, and nothing after it.
    ///
    /// Removing the offending characters is not enough: strip the spaces,
    /// colons and slashes out of "IOException: C:\Users\person\secret to
    /// 10.1.2.3" and the account name and the address are still in there, just
    /// harder to read. What is safe is to keep only the run of characters at
    /// the front that could be a type name and drop everything from the first
    /// character that could not be -- which is exactly where a message starts.
    private static string SafeTypeName(string value)
    {
        var end = 0;
        while (end < value.Length && (char.IsAsciiLetterOrDigit(value[end]) || value[end] is '.' or '_' or '+' or '`'))
            end++;
        var kept = value[..end];
        return kept.Length == 0 || !(char.IsAsciiLetter(kept[0]) || kept[0] == '_') ? "Unknown" : Trim(kept, 128);
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

    /// One counter, for the callers that need a single value rather than the
    /// whole set. Reading them all to look at one is cheap on a small table
    /// and misleading in a profile.
    public long ReadCounter(string name)
    {
        lock (gate)
        {
            var safeName = name.Replace("'", "''", StringComparison.Ordinal);
            return ScalarInt64($"SELECT COALESCE((SELECT value FROM collector_counters WHERE name='{safeName}'),0)");
        }
    }

    /// Replaces rather than adds, for values that are a measurement and not a
    /// tally. A duration accumulated across restarts is not a duration.
    public void SetCounter(string name, long value)
    {
        lock (gate)
        {
            var safeName = name.Replace("'", "''", StringComparison.Ordinal);
            Execute($"INSERT INTO collector_counters(name,value) VALUES('{safeName}',{value}) " +
                    "ON CONFLICT(name) DO UPDATE SET value=excluded.value");
        }
    }

    public (long Count, string Integrity) Inspect(bool verifyIntegrity = true)
    {
        lock (gate)
        {
            var count = ScalarInt64("SELECT COUNT(*) FROM observations");
            var integrity = verifyIntegrity ? ScalarText("PRAGMA integrity_check") : lastVerifiedIntegrity;
            if (verifyIntegrity) lastVerifiedIntegrity = integrity;
            return (count, integrity);
        }
    }

    /// <summary>
    /// Bytes occupied by durable database state, including SQLite sidecars and
    /// retained pre-migration backups. Missing/racing sidecars contribute zero.
    /// </summary>
    public long ReadStorageBytes()
    {
        lock (gate)
        {
            ThrowIfDisposed();
            var files = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                path,
                $"{path}-wal",
                $"{path}-shm",
                $"{path}-journal",
            };
            var directory = Path.GetDirectoryName(path)!;
            var backupPattern = Path.GetFileName(path) + ".pre-v*.bak";
            try
            {
                foreach (var backup in Directory.EnumerateFiles(directory, backupPattern, SearchOption.TopDirectoryOnly))
                    files.Add(backup);
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }

            long total = 0;
            foreach (var file in files)
            {
                try { total = checked(total + new FileInfo(file).Length); }
                catch (FileNotFoundException) { }
                catch (DirectoryNotFoundException) { }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
                catch (OverflowException) { return long.MaxValue; }
            }
            return total;
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

    /// <summary>
    /// The most hours one pass folds. See the bound's reason where it is used.
    private const int MaximumHoursPerFold = 6;

    /// How long an hour is left alone after it ends before it is folded.
    ///
    /// An observation is not written the instant its traffic happens. The
    /// per-second summing holds a bucket until the event timeline has moved
    /// past it, a name that could not be resolved is held until the process
    /// exits or the wait expires, and ETW callbacks arrive late under load.
    /// Folding an hour the moment it ends means anything arriving afterwards
    /// belongs to a summarised hour -- and a summarised hour is not read raw,
    /// so it would be counted nowhere at all. Five minutes is far longer than
    /// any of those waits, and costs only that the newest complete hour is
    /// read from observations for a few minutes longer.
    private static readonly TimeSpan FoldSettlingPeriod = TimeSpan.FromMinutes(5);

    /// The latest hour boundary that may be folded now.
    private static DateTimeOffset FoldBoundary(DateTimeOffset now)
    {
        var settled = now.ToUniversalTime() - FoldSettlingPeriod;
        return new DateTimeOffset(settled.Year, settled.Month, settled.Day, settled.Hour, 0, 0, TimeSpan.Zero);
    }

    /// Whole hours still waiting to be folded.
    ///
    /// The count of rows a pass wrote cannot answer this: an hour in which
    /// nothing happened folds to nothing, and a caller watching for zero would
    /// stop while hours remained. Retention deletes raw observations that are
    /// old enough, so stopping early would delete hours that had never been
    /// summarised -- the one thing the fold exists to prevent.
    public long PendingChartFoldHours(DateTimeOffset now)
    {
        var currentHour = FoldBoundary(now);
        lock (gate)
        {
            ThrowIfDisposed();
            var watermarkText = NullableScalarText("SELECT MAX(folded_through) FROM chart_hourly_state");
            var watermark = watermarkText is null
                ? OldestObservation() is { } oldest
                    ? oldest.ToUniversalTime()
                    : currentHour
                : DateTimeOffset.Parse(watermarkText).ToUniversalTime();
            var hours = (currentHour - watermark).TotalHours;
            return hours <= 0 ? 0 : (long)Math.Ceiling(hours);
        }
    }

    /// Folds complete UTC hours into the bounded chart aggregate. The current
    /// hour remains raw so a refresh never double-counts an hour still changing.
    /// </summary>
    public long FoldCompletedHoursForCharts(DateTimeOffset now)
    {
        var currentHour = FoldBoundary(now);
        lock (gate)
        {
            ThrowIfDisposed();
            var watermarkText = NullableScalarText("SELECT MAX(folded_through) FROM chart_hourly_state");
            DateTimeOffset watermark;
            if (watermarkText is null)
            {
                var oldestText = OldestObservation();
                if (oldestText is null)
                {
                    Execute($"INSERT INTO chart_hourly_state(id,folded_through) VALUES(1,'{currentHour:O}')");
                    return 0;
                }
                var oldest = oldestText.Value.ToUniversalTime();
                watermark = new DateTimeOffset(oldest.Year, oldest.Month, oldest.Day, oldest.Hour, 0, 0, TimeSpan.Zero);
            }
            else watermark = DateTimeOffset.Parse(watermarkText).ToUniversalTime();
            if (watermark >= currentHour) return 0;
            // One pass covers a bounded stretch of hours. A database rebuilding
            // a fortnight of history would otherwise hold a single transaction
            // open across every raw observation it has, which is minutes of the
            // lock every other reader needs. Passes run a minute apart, so a
            // fortnight catches up in about an hour without ever blocking the
            // window for longer than one stretch takes.
            var foldTo = watermark.AddHours(MaximumHoursPerFold);
            if (foldTo > currentHour) foldTo = currentHour;

            Execute("BEGIN IMMEDIATE");
            try
            {
                Execute($"""
                    INSERT INTO chart_hourly(bucket_start,application,layer,scope,observation_count,flow_count,bytes_sent,bytes_received,bytes_unknown)
                    SELECT {ObservedHourStart},
                           COALESCE(NULLIF(process_name,''),'Unknown'),layer,{ObservedScope},COUNT(*),
                           COUNT(DISTINCT {FlowIdentity}),
                           SUM(COALESCE(bytes_sent,0)),SUM(COALESCE(bytes_received,0)),
                           SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
                    FROM observations
                    WHERE observed_at>={watermark.UtcTicks} AND observed_at<{foldTo.UtcTicks}
                    GROUP BY 1,2,layer,4
                    ON CONFLICT(bucket_start,application,layer,scope) DO UPDATE SET
                      observation_count=observation_count+excluded.observation_count,
                      -- Added, not replaced, for the same reason the others
                      -- are: a bucket can be folded in more than one pass.
                      -- This over-counts a connection that spans two passes,
                      -- which is the error of one, against a replacement that
                      -- would throw away everything the earlier pass saw.
                      flow_count=flow_count+excluded.flow_count,
                      bytes_sent=bytes_sent+excluded.bytes_sent,
                      bytes_received=bytes_received+excluded.bytes_received,
                      bytes_unknown=bytes_unknown+excluded.bytes_unknown;
                    INSERT INTO chart_hourly_destination(bucket_start,application,remote_address,layer,remote_hostname,flow_count,observation_count,bytes_sent,bytes_received,bytes_unknown)
                    SELECT {ObservedHourStart},
                           COALESCE(NULLIF(process_name,''),'Unknown'),remote_address,layer,
                           MAX(NULLIF(remote_hostname,'')),
                           COUNT(DISTINCT {FlowIdentity}),COUNT(*),
                           SUM(COALESCE(bytes_sent,0)),SUM(COALESCE(bytes_received,0)),
                           SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
                    FROM observations
                    WHERE observed_at>={watermark.UtcTicks} AND observed_at<{foldTo.UtcTicks}
                    GROUP BY 1,2,remote_address,layer
                    ON CONFLICT(bucket_start,application,remote_address,layer) DO UPDATE SET
                      remote_hostname=COALESCE(chart_hourly_destination.remote_hostname,excluded.remote_hostname),
                      flow_count=flow_count+excluded.flow_count,
                      observation_count=observation_count+excluded.observation_count,
                      bytes_sent=bytes_sent+excluded.bytes_sent,
                      bytes_received=bytes_received+excluded.bytes_received,
                      bytes_unknown=bytes_unknown+excluded.bytes_unknown;
                    INSERT INTO chart_hourly_state(id,folded_through) VALUES(1,'{foldTo:O}')
                    ON CONFLICT(id) DO UPDATE SET folded_through=excluded.folded_through;
                    """);
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
            return ScalarInt64($"SELECT COUNT(*) FROM chart_hourly WHERE bucket_start>='{watermark:O}' AND bucket_start<'{foldTo:O}'");
        }
    }

    public IReadOnlyList<RecentFlow> ReadRecentFlows(int limit, int offset = 0)
    {
        if (limit is not (50 or 100 or 200 or 500)) throw new ArgumentOutOfRangeException(nameof(limit));
        if (offset is < 0 or > 1_000_000) throw new ArgumentOutOfRangeException(nameof(offset));
        lock (gate)
        {
            const string columns = "f.first_seen,f.last_seen,f.protocol,f.local_address,f.local_port,f.remote_address,f.remote_port,f.process_id,f.process_name,f.bytes_sent,f.bytes_received,f.layer,f.interface_id,f.origin,f.remote_hostname,COALESCE(g.country_code,lc.country_code),f.process_instance_id";
            var sql = $"SELECT {columns} FROM flows f LEFT JOIN geo_locations g ON g.ip=f.remote_address LEFT JOIN local_country_cache lc ON lc.ip=f.remote_address ORDER BY f.last_seen DESC,f.flow_key LIMIT {limit} OFFSET {offset}";
            return ReadRecentFlowQuery(sql);
        }
    }

    /// The log as events rather than as conversations.
    ///
    /// `flows` holds one running row per conversation, so a row there covers a
    /// span and keeps changing. `observations` is append-only: each row is one
    /// thing that happened at one instant and never moves again. Both are
    /// legitimate readings of "the connection log", and they answer different
    /// questions, so the reader picks.
    ///
    /// An observation's span is a point, so both ends of it are the same
    /// moment. That is not padding to fit the shape -- it is what a single
    /// event's duration is.
    public IReadOnlyList<RecentFlow> ReadRecentObservations(int limit, int offset = 0)
    {
        if (limit is not (50 or 100 or 200 or 500)) throw new ArgumentOutOfRangeException(nameof(limit));
        if (offset is < 0 or > 1_000_000) throw new ArgumentOutOfRangeException(nameof(offset));
        lock (gate)
        {
            // observed_at twice: an event begins and ends at the same instant.
            // No hostname column here -- enrichment lands on the flow, not on
            // the event, so this reads as unresolved rather than as wrong.
            const string columns = "o.observed_at,o.observed_at,fl.protocol,fl.local_address,fl.local_port,o.remote_address," +
                "o.remote_port,fl.process_id,o.process_name,o.bytes_sent,o.bytes_received,o.layer,fl.interface_id,o.source,NULL,COALESCE(g.country_code,lc.country_code),o.process_instance_id";
            var sql = $"SELECT {columns} FROM observations o JOIN flows fl ON fl.rowid=o.flow_id LEFT JOIN geo_locations g ON g.ip=o.remote_address LEFT JOIN local_country_cache lc ON lc.ip=o.remote_address " +
                $"ORDER BY o.observed_at DESC,o.id DESC LIMIT {limit} OFFSET {offset}";
            return ReadRecentFlowQuery(sql);
        }
    }

    /// The page, together with the point in the event stream it was taken at.
    ///
    /// Both under one lock on purpose. Read separately, anything written
    /// between the two reads is either counted twice or missed, and a log that
    /// double-counts is worse than a slow one.
    public ObservationPage ReadLogSnapshot(int limit, bool asEvents)
    {
        if (limit is not (50 or 100 or 200 or 500)) throw new ArgumentOutOfRangeException(nameof(limit));
        lock (gate)
        {
            var cursor = ScalarInt64("SELECT COALESCE(MAX(id),0) FROM observations");
            return new(cursor, false, asEvents ? ReadRecentObservations(limit) : ReadRecentFlows(limit));
        }
    }

    /// What happened after a given point in the stream, oldest first.
    ///
    /// Keyed on the rowid rather than on a timestamp. `observed_at` is neither
    /// unique nor guaranteed to move forwards -- a clock that steps back would
    /// make rows vanish from the stream -- while the rowid only ever
    /// increases. It also makes an omission detectable: if the page fills, the
    /// caller knows there is more rather than quietly showing a fraction.
    public ObservationPage ReadObservationsSince(long afterId, int limit)
    {
        if (afterId < 0) throw new ArgumentOutOfRangeException(nameof(afterId));
        if (limit is < 1 or > 2_000) throw new ArgumentOutOfRangeException(nameof(limit));
        lock (gate)
        {
            const string columns = "o.observed_at,o.observed_at,fl.protocol,fl.local_address,fl.local_port,o.remote_address," +
                "o.remote_port,fl.process_id,o.process_name,o.bytes_sent,o.bytes_received,o.layer,fl.interface_id,o.source,NULL,COALESCE(g.country_code,lc.country_code),o.process_instance_id";
            var sql = $"SELECT {columns},o.id FROM observations o JOIN flows fl ON fl.rowid=o.flow_id LEFT JOIN geo_locations g ON g.ip=o.remote_address LEFT JOIN local_country_cache lc ON lc.ip=o.remote_address " +
                $"WHERE o.id>{afterId} ORDER BY o.id LIMIT {limit}";
            var rows = ReadRecentFlowQuery(sql, out var lastId);
            var newest = ScalarInt64("SELECT COALESCE(MAX(id),0) FROM observations");
            // The cursor advances to the newest row even when nothing matched,
            // so an idle stream does not re-ask the same question forever.
            return new(rows.Count == 0 ? newest : lastId, rows.Count >= limit && lastId < newest, rows);
        }
    }

    /// A time from either table.
    ///
    /// observations count in ticks and flows still spell theirs out, and this
    /// one reader serves queries over both. The column's own type says which
    /// it is, which is a fact about the row rather than a guess about the
    /// query that fetched it.
    private static DateTimeOffset Moment(nint statement, int column) =>
        WinSqlite.ColumnType(statement, column) == 1
            ? new DateTimeOffset(WinSqlite.ColumnInt64(statement, column), TimeSpan.Zero)
            : DateTimeOffset.Parse(Text(statement, column));

    private IReadOnlyList<RecentFlow> ReadRecentFlowQuery(string sql) => ReadRecentFlowQuery(sql, out _);

    private IReadOnlyList<RecentFlow> ReadRecentFlowQuery(string sql, out long lastId)
    {
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        var result = new List<RecentFlow>();
        lastId = 0;
        try
        {
            while (true)
            {
                var code = WinSqlite.Step(statement);
                if (code == WinSqlite.Done) break;
                CheckQueryRow(code);
                result.Add(new RecentFlow(
                    Moment(statement, 0), Moment(statement, 1),
                    Text(statement, 2), Text(statement, 3), (int)WinSqlite.ColumnInt64(statement, 4),
                    Text(statement, 5), (int)WinSqlite.ColumnInt64(statement, 6), (int)WinSqlite.ColumnInt64(statement, 7),
                    NullableTextValue(statement, 8), NullableInt64(statement, 9), NullableInt64(statement, 10),
                    Text(statement, 11) == "vpn_transport" ? ObservationLayer.VpnTransport : ObservationLayer.Logical,
                    NullableTextValue(statement, 12), Text(statement, 13), NullableTextValue(statement, 14), NullableTextValue(statement, 15),
                    NullableTextValue(statement, 16)));
                if (WinSqlite.ColumnCount(statement) > 17) lastId = WinSqlite.ColumnInt64(statement, 17);
            }
        }
        finally { WinSqlite.Finalize(statement); }
        return result;
    }

    public GeoCacheState ReadGeoCacheState()
    {
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, "SELECT etag,fetched_at,(SELECT COUNT(*) FROM geo_locations) FROM geo_cache_state WHERE id=1", -1, out var statement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(statement));
                var etag = NullableTextValue(statement, 0);
                var fetched = NullableTextValue(statement, 1);
                return new(etag, fetched is null ? null : DateTimeOffset.Parse(fetched), WinSqlite.ColumnInt64(statement, 2));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    /// Destinations seen recently that nobody has placed yet.
    ///
    /// The Hub's cache is asked first and this only covers what it did not
    /// answer, so a machine with a Hub keeps the richer result -- coordinates
    /// and a city -- and a machine without one stops having nothing.
    public IReadOnlyList<string> ReadAddressesWithoutCountry(DateTimeOffset since, int limit = 500)
    {
        if (limit is < 1 or > 5000) throw new ArgumentOutOfRangeException(nameof(limit));
        lock (gate)
        {
            var sql = "SELECT DISTINCT f.remote_address FROM flows f " +
                "LEFT JOIN geo_locations g ON g.ip=f.remote_address " +
                "LEFT JOIN local_country_cache lc ON lc.ip=f.remote_address " +
                $"WHERE f.layer='logical' AND f.last_seen>='{since:O}' " +
                "AND (g.country_code IS NULL OR TRIM(g.country_code)='') AND lc.ip IS NULL " +
                $"LIMIT {limit}";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<string>();
            try { while (WinSqlite.Step(statement) == WinSqlite.Row) result.Add(Text(statement, 0)); }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    public void SaveLocalCountries(IReadOnlyList<(string Ip, string CountryCode)> answers)
    {
        if (answers.Count == 0) return;
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                const string sql = "INSERT INTO local_country_cache(ip,country_code,resolved_at) VALUES(?,?,?) " +
                    "ON CONFLICT(ip) DO UPDATE SET country_code=excluded.country_code,resolved_at=excluded.resolved_at";
                CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                try
                {
                    var now = DateTimeOffset.UtcNow.ToString("O");
                    foreach (var (ip, country) in answers)
                    {
                        Bind(statement, 1, ip);
                        Bind(statement, 2, country);
                        Bind(statement, 3, now);
                        CheckDone(WinSqlite.Step(statement));
                        Check(WinSqlite.Reset(statement));
                    }
                }
                finally { WinSqlite.Finalize(statement); }
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    /// Addresses with no location at all, for the paths that can fetch one.
    ///
    /// Distinct from ReadAddressesWithoutCountry: a country worked out from
    /// the local table is an answer for the country list but not for the
    /// globe, which needs coordinates. An address placed only locally is
    /// therefore still worth asking about here.
    public IReadOnlyList<string> ReadAddressesWithoutLocation(DateTimeOffset since, int limit = 25)
    {
        if (limit is < 1 or > 5000) throw new ArgumentOutOfRangeException(nameof(limit));
        lock (gate)
        {
            // An address a lookup already failed on is left alone for a week.
            // Allocations do move, so this is a delay rather than a verdict.
            var retryFrom = DateTimeOffset.UtcNow - MissRetryAfter;
            var sql = "SELECT DISTINCT f.remote_address FROM flows f " +
                "LEFT JOIN geo_locations g ON g.ip=f.remote_address " +
                "LEFT JOIN geo_lookup_misses m ON m.ip=f.remote_address " +
                $"WHERE f.layer='logical' AND f.last_seen>='{since:O}' AND g.ip IS NULL " +
                $"AND (m.ip IS NULL OR m.missed_at < '{retryFrom:O}') " +
                $"ORDER BY f.last_seen DESC LIMIT {limit}";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<string>();
            try { while (WinSqlite.Step(statement) == WinSqlite.Row) result.Add(Text(statement, 0)); }
            finally { WinSqlite.Finalize(statement); }
            return result;
        }
    }

    /// How many locations were bought one at a time rather than arriving in
    /// the Hub's cache. Reported so that paying for the same address twice is
    /// visible rather than merely expensive.
    public long ReadLookedUpLocationCount()
    {
        lock (gate) return ScalarInt64("SELECT COUNT(*) FROM geo_locations WHERE source='lookup'");
    }

    /// How long an address that could not be placed is left alone.
    ///
    /// Allocations move, so this is a delay and not a verdict.
    public static readonly TimeSpan MissRetryAfter = TimeSpan.FromDays(7);

    /// Records that a lookup was made and found nothing.
    public void RecordGeoLookupMisses(IReadOnlyList<string> addresses, DateTimeOffset at)
    {
        if (addresses.Count == 0) return;
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                const string sql = "INSERT INTO geo_lookup_misses(ip,missed_at) VALUES(?,?) " +
                    "ON CONFLICT(ip) DO UPDATE SET missed_at=excluded.missed_at";
                CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
                try
                {
                    foreach (var address in addresses)
                    {
                        Bind(statement, 1, address);
                        Bind(statement, 2, at.ToUniversalTime().ToString("O"));
                        CheckDone(WinSqlite.Step(statement));
                        Check(WinSqlite.Reset(statement));
                        Check(WinSqlite.ClearBindings(statement));
                    }
                }
                finally { WinSqlite.Finalize(statement); }
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    /// Adds locations without discarding the ones already held.
    ///
    /// ReplaceGeoLocations empties the table first, which is right for the
    /// daily cache and wrong for an answer about a single address: using it
    /// here would throw away eighty thousand rows to record one.
    public void SaveGeoLocations(IReadOnlyList<GeoLocation> locations)
    {
        if (locations.Count == 0) return;
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                const string sql = "INSERT INTO geo_locations(ip,latitude,longitude,country_code,city,source) VALUES(?,?,?,?,?,'lookup') " +
                    "ON CONFLICT(ip) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude," +
                    "country_code=excluded.country_code,city=excluded.city,source='lookup'";
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
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    /// How many addresses this PC placed without asking anyone.
    ///
    /// Reported so the screen can say whether the table is doing anything. A
    /// table that loads, reports "in use", and answers nothing looks identical
    /// to one that is working, and that is the shape of the failure this
    /// feature is most likely to have.
    public long ReadLocalCountryCount()
    {
        lock (gate) return ScalarInt64("SELECT COUNT(*) FROM local_country_cache");
    }

    /// Thrown away when the table is replaced or withdrawn, because an answer
    /// from a table nobody has any more is an answer nobody can check.
    public void ForgetLocalCountries()
    {
        lock (gate) Execute("DELETE FROM local_country_cache");
    }

    public void ReplaceGeoLocations(IReadOnlyList<GeoLocation> locations, string? etag, DateTimeOffset fetchedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                // Only the Hub's own rows. An address looked up one at a time
                // is not part of the cache the Hub sends, so replacing the
                // cache must not take it away -- it was paid for out of a
                // daily allowance, and losing it means buying it again.
                Execute("DELETE FROM geo_locations WHERE source='hub'");
                // The Hub's answer carries a city and is the better one, so it
                // takes over an address a lookup had placed.
                const string sql = "INSERT INTO geo_locations(ip,latitude,longitude,country_code,city,source) VALUES(?,?,?,?,?,'hub') " +
                    "ON CONFLICT(ip) DO UPDATE SET latitude=excluded.latitude,longitude=excluded.longitude," +
                    "country_code=excluded.country_code,city=excluded.city,source='hub'";
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

    public IReadOnlyList<CountryHistoryRow> ReadCountryHistory(DateTimeOffset? from = null, DateTimeOffset? to = null)
    {
        if (from is not null && to is not null && from >= to) throw new ArgumentOutOfRangeException(nameof(from));
        lock (gate)
        {
            var range = from is not null && to is not null
                ? $" AND f.last_seen>='{from.Value.ToUniversalTime():O}' AND f.first_seen<'{to.Value.ToUniversalTime():O}'"
                : string.Empty;
            var sql = $"""
                SELECT UPPER(COALESCE(g.country_code,lc.country_code)),COUNT(*),MIN(f.first_seen),MAX(f.last_seen),
                       MAX(f.last_seen || CHAR(31) || COALESCE(f.process_name,''))
                FROM flows f
                LEFT JOIN geo_locations g ON g.ip=f.remote_address
                LEFT JOIN local_country_cache lc ON lc.ip=f.remote_address
                WHERE f.layer='logical' AND COALESCE(g.country_code,lc.country_code) IS NOT NULL AND TRIM(COALESCE(g.country_code,lc.country_code))<>''{range}
                GROUP BY UPPER(COALESCE(g.country_code,lc.country_code))
                ORDER BY COUNT(*) DESC,UPPER(COALESCE(g.country_code,lc.country_code))
                """;
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
            var result = new List<CountryHistoryRow>();
            try
            {
                while (WinSqlite.Step(statement) == WinSqlite.Row)
                {
                    var latest = Text(statement, 4);
                    var separator = latest.IndexOf((char)31);
                    var recentApp = separator >= 0 ? latest[(separator + 1)..] : string.Empty;
                    result.Add(new CountryHistoryRow(Text(statement, 0), WinSqlite.ColumnInt64(statement, 1),
                        DateTimeOffset.Parse(Text(statement, 2)), DateTimeOffset.Parse(Text(statement, 3)),
                        string.IsNullOrWhiteSpace(recentApp) ? null : recentApp));
                }
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
            var fromTicks = from.ToUniversalTime().UtcTicks;
            var toTicks = to.ToUniversalTime().UtcTicks;
            // A PID is not an application. Keying nameless flows by their PID
            // made every unnamed process its own "application", so the count
            // reported thousands where the machine runs dozens. They all fold
            // into one bucket the reader can see and question instead.
            const string app = "COALESCE(NULLIF(process_name,''),'Unknown')";
            var where = $"last_seen>='{fromText}' AND first_seen<'{toText}' AND layer='logical'";

            // The hours this period reads from folded aggregates rather than
            // raw rows: whole hours inside the period, up to the fold
            // watermark. Raw observations cover everything outside it, so the
            // two together are the period exactly once.
            var fromUtc = from.ToUniversalTime();
            var toUtc = to.ToUniversalTime();
            var aggregateStart = new DateTimeOffset(fromUtc.Year, fromUtc.Month, fromUtc.Day, fromUtc.Hour, 0, 0, TimeSpan.Zero);
            if (aggregateStart < fromUtc) aggregateStart = aggregateStart.AddHours(1);
            var aggregateEnd = new DateTimeOffset(toUtc.Year, toUtc.Month, toUtc.Day, toUtc.Hour, 0, 0, TimeSpan.Zero);
            var foldWatermarkText = NullableScalarText("SELECT MAX(folded_through) FROM chart_hourly_state");
            var foldWatermark = foldWatermarkText is null ? aggregateStart : DateTimeOffset.Parse(foldWatermarkText).ToUniversalTime();
            if (aggregateEnd > foldWatermark) aggregateEnd = foldWatermark;
            if (aggregateEnd < aggregateStart) aggregateEnd = aggregateStart;
            // How many connections, applications and destinations the period
            // touched: properties of the flows themselves, so counted from
            // flows. A flow that outlived the period still touched it.
            // Loopback is counted apart rather than counted in. "How many
            // destinations" is a question about where things went, and a flow
            // to 127.0.0.1 did not go anywhere.
            // The named share comes from the same row set as the destination
            // count, so the card and the chart below it cannot be counting
            // different populations.
            //
            // Null is the whole test. NormalizeDomain is the only way a name
            // reaches this column and it returns null for anything blank and
            // for anything that parses as an address, so "not empty" and "not
            // the address written out again" are already true of every row --
            // measured: none of 650,325 flows has either. Restating them here
            // would read as a safeguard while never being able to be false,
            // and two of them survived a mutation run saying exactly that.
            var named = "remote_hostname IS NOT NULL";
            var totalsSql = $"SELECT COUNT(*),COUNT(DISTINCT {app}),COUNT(DISTINCT remote_address),SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END),"
                + $"COUNT(DISTINCT CASE WHEN {named} THEN remote_address END),"
                // The same question asked of connections rather than of
                // addresses. On this machine the two answers are 93% and 11%:
                // the destinations that resolve are the majority, and the ones
                // that do not carry almost all the traffic -- a monitoring
                // poller to one LAN address was 17,818 connections in six
                // hours. A reader looking at a chart sorted by connections is
                // looking at the second number.
                + $"SUM(CASE WHEN {named} THEN 1 ELSE 0 END) FROM flows WHERE {where} AND NOT {DestinationScope.LoopbackSql()}";
            CheckOperation(WinSqlite.Prepare(db, totalsSql, -1, out var totalsStatement, 0));
            long connections; int applications; int destinations; long bytes; long unknown; long sent; long received;
            var namedDestinations = 0;
            long namedConnections = 0;
            try
            {
                CheckQueryRow(WinSqlite.Step(totalsStatement));
                connections = WinSqlite.ColumnInt64(totalsStatement, 0);
                applications = (int)WinSqlite.ColumnInt64(totalsStatement, 1);
                destinations = (int)WinSqlite.ColumnInt64(totalsStatement, 2);
                unknown = WinSqlite.ColumnInt64(totalsStatement, 3);
                namedDestinations = (int)WinSqlite.ColumnInt64(totalsStatement, 4);
                namedConnections = WinSqlite.ColumnInt64(totalsStatement, 5);
            }
            finally { WinSqlite.Finalize(totalsStatement); }

            var unseparated = ScalarInt64(
                $"SELECT COUNT(*) FROM chart_hourly WHERE bucket_start>='{aggregateStart:O}' "
                + $"AND bucket_start<'{aggregateEnd:O}' AND scope='mixed'") > 0;

            long localConnections = 0; var localDestinations = 0;
            CheckOperation(WinSqlite.Prepare(db,
                $"SELECT COUNT(*),COUNT(DISTINCT remote_address) FROM flows WHERE {where} AND {DestinationScope.LoopbackSql()}",
                -1, out var localStatement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(localStatement));
                localConnections = WinSqlite.ColumnInt64(localStatement, 0);
                localDestinations = (int)WinSqlite.ColumnInt64(localStatement, 1);
            }
            finally { WinSqlite.Finalize(localStatement); }

            // Bytes are not. A flow row carries its whole life's total, so
            // summing the flows that overlap a period charges the period for
            // traffic that happened outside it -- an svchost connection opened
            // eighteen hours ago reported its eighteen hours into every hour it
            // touched. Measured on one machine, the last hour read 980 MB where
            // the hour's own traffic was 650 MB, so a fresh 30 MB download moved
            // a figure that was half history by three percent, and looked to the
            // reader like nothing had been captured at all.
            //
            // An observation carries one event's bytes at one time, and a folded
            // hour is their sum, so both fall in the period they belong to.
            var bytesSql = $"""
                SELECT COALESCE(SUM(sent),0),COALESCE(SUM(received),0) FROM (
                  SELECT bytes_sent AS sent,bytes_received AS received FROM chart_hourly
                  WHERE bucket_start>='{aggregateStart:O}' AND bucket_start<'{aggregateEnd:O}' AND layer='logical'
                    AND {CountableScopes}
                  UNION ALL
                  SELECT bytes_sent,bytes_received FROM hourly_summary h
                  WHERE bucket_start>='{aggregateStart:O}' AND bucket_start<'{aggregateEnd:O}' AND layer='logical'
                    AND NOT EXISTS(SELECT 1 FROM chart_hourly c WHERE c.bucket_start=h.bucket_start AND c.layer=h.layer)
                  UNION ALL
                  -- The hours the fold has not reached, as two ranges rather
                  -- than one range with a hole in it. Written as a hole, the
                  -- index serves the outer range and the OR is a filter over
                  -- every row inside it: measured on a month, 2.67 seconds to
                  -- find 27,000 rows among 34 million. As two ranges it is
                  -- 0.02, because each one is an index seek.
                  SELECT COALESCE(bytes_sent,0),COALESCE(bytes_received,0) FROM observations
                  WHERE observed_at>={fromTicks} AND observed_at<{aggregateStart.UtcTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                  UNION ALL
                  SELECT COALESCE(bytes_sent,0),COALESCE(bytes_received,0) FROM observations
                  WHERE observed_at>={aggregateEnd.UtcTicks} AND observed_at<{toTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                )
                """;
            CheckOperation(WinSqlite.Prepare(db, bytesSql, -1, out var bytesStatement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(bytesStatement));
                sent = WinSqlite.ColumnInt64(bytesStatement, 0);
                received = WinSqlite.ColumnInt64(bytesStatement, 1);
                bytes = sent + received;
            }
            finally { WinSqlite.Finalize(bytesStatement); }

            var links = new List<AppDestinationAggregate>();
            const string qualifiedApp = "COALESCE(NULLIF(f.process_name,''),'Unknown')";
            // Per destination, the same correction, from raw observations --
            // there is no per-destination aggregate to fall back on, so beyond
            // the raw retention window the bytes are genuinely gone and zero is
            // the honest answer where the old sum invented one.
            //
            // One row per application and destination address now, named by
            // whichever hostname was seen for it. Grouping by the name as well
            // split a destination in two whenever one address answered to two
            // names, and half a destination is not something a reader can use.
            var linksSql = $"""
                WITH parts AS (
                  SELECT application,remote_address,bytes_sent+bytes_received AS bytes
                  FROM chart_hourly_destination
                  WHERE bucket_start>='{aggregateStart:O}' AND bucket_start<'{aggregateEnd:O}' AND layer='logical'
                  UNION ALL
                  SELECT {app},remote_address,COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)
                  FROM observations
                  WHERE observed_at>={fromTicks} AND observed_at<{aggregateStart.UtcTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                  UNION ALL
                  SELECT {app},remote_address,COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)
                  FROM observations
                  WHERE observed_at>={aggregateEnd.UtcTicks} AND observed_at<{toTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                ), measured AS (
                  SELECT application,remote_address,SUM(bytes) AS bytes FROM parts GROUP BY 1,2
                )
                SELECT {qualifiedApp},f.remote_address,MAX(COALESCE(NULLIF(f.remote_hostname,''),f.remote_address)),
                       COUNT(*),COALESCE(MAX(measured.bytes),0),
                       SUM(CASE WHEN f.bytes_sent IS NULL OR f.bytes_received IS NULL THEN 1 ELSE 0 END)
                FROM flows f
                LEFT JOIN measured ON measured.application={qualifiedApp} AND measured.remote_address=f.remote_address
                WHERE f.last_seen>='{fromText}' AND f.first_seen<'{toText}' AND f.layer='logical'
                  AND NOT {DestinationScope.LoopbackSql("f")}
                GROUP BY 1,2 ORDER BY 4 DESC,1,2 LIMIT 512
                """;
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
            var widthSeconds = durationSeconds / bucketCount;
            // Buckets narrower than an hour are filled from the raw rows, for
            // the whole period, exactly as the Mac Agent does it.
            //
            // An hourly row cannot be cut into a shorter bucket. Reading it
            // into one puts a whole hour into a single bar and leaves its
            // neighbours empty -- a chart of spikes and gaps that looks like
            // the machine stopped talking.
            //
            // Widening the buckets to an hour instead was tried and taken out
            // again: it made a day's bars two and a half times wider than
            // every other period's, and the bar width is how a reader tells
            // one chart from another. Measured after the summing landed, a day
            // is 849,249 rows and 1.2 seconds -- the cost that made the
            // widening look necessary was 6,500,653 rows of one-row-per-packet
            // history, and that is gone.
            if (widthSeconds < 3600) aggregateEnd = aggregateStart;
            var widthText = widthSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture);
            // Whole seconds, not a difference of julian days.
            //
            // julianday returns a fractional day, and the fraction cannot hold
            // an exact hour: measured here, 04:00 came back as 14,399.999987
            // seconds after midnight, which divided by an hour and truncated
            // is bucket 3. Every other hourly bar landed one place to the left
            // of where its traffic happened. Epoch seconds are integers and
            // the subtraction is exact; sub-second precision is not something
            // a bucket a second or wider can show.
            var fromEpoch = from.ToUniversalTime().ToUnixTimeSeconds();
            var timelineSql = $"""
                WITH combined AS (
                  SELECT MIN({bucketCount - 1},MAX(0,CAST((CAST(strftime('%s',bucket_start) AS INTEGER)-{fromEpoch})/{widthText} AS INTEGER))) AS bucket,
                         application,SUM(flow_count) AS connections,
                         SUM(bytes_sent+bytes_received) AS bytes,SUM(bytes_unknown) AS unknown
                  FROM chart_hourly
                  WHERE bucket_start>='{aggregateStart:O}' AND bucket_start<'{aggregateEnd:O}' AND layer='logical'
                    AND {CountableScopes}
                  GROUP BY bucket,application
                  UNION ALL
                  SELECT MIN({bucketCount - 1},MAX(0,CAST(({ObservedUnixSeconds}-{fromEpoch})/{widthText} AS INTEGER))) AS bucket,
                         {app},COUNT(DISTINCT {FlowIdentity}),
                         SUM(COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)),
                         SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
                  FROM observations
                  WHERE observed_at>={fromTicks} AND observed_at<{aggregateStart.UtcTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                  GROUP BY bucket,2
                  UNION ALL
                  SELECT MIN({bucketCount - 1},MAX(0,CAST(({ObservedUnixSeconds}-{fromEpoch})/{widthText} AS INTEGER))) AS bucket,
                         {app},COUNT(DISTINCT {FlowIdentity}),
                         SUM(COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)),
                         SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END)
                  FROM observations
                  WHERE observed_at>={aggregateEnd.UtcTicks} AND observed_at<{toTicks} AND layer='logical' AND NOT {DestinationScope.LoopbackSql()}
                  GROUP BY bucket,2
                  UNION ALL
                  -- Hours the per-application fold never covered. There is no
                  -- connection count to recover from a protocol summary, so
                  -- these contribute bytes and nothing to the bars; a drawn
                  -- zero would be read as "nothing happened".
                  SELECT MIN({bucketCount - 1},MAX(0,CAST((CAST(strftime('%s',bucket_start) AS INTEGER)-{fromEpoch})/{widthText} AS INTEGER))) AS bucket,
                         'Other',0,SUM(bytes_sent+bytes_received),SUM(bytes_unknown)
                  FROM hourly_summary h
                  WHERE bucket_start>='{aggregateStart:O}' AND bucket_start<'{aggregateEnd:O}' AND layer='logical'
                    AND NOT EXISTS(SELECT 1 FROM chart_hourly c WHERE c.bucket_start=h.bucket_start AND c.layer=h.layer)
                  GROUP BY bucket
                )
                SELECT bucket,application,SUM(connections),SUM(bytes),SUM(unknown) FROM combined
                GROUP BY bucket,application ORDER BY bucket,application
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

            var topApplications = timeline.GroupBy(item => item.Application)
                .OrderByDescending(group => group.Sum(item => item.Connections)).ThenBy(group => group.Key, StringComparer.Ordinal)
                .Take(6).Select(group => group.Key).ToHashSet(StringComparer.Ordinal);
            timeline = timeline.GroupBy(item => (item.Bucket, Application: topApplications.Contains(item.Application) ? item.Application : "Other"))
                .Select(group => new AppTimelineAggregate(group.Key.Bucket, group.Key.Application,
                    group.Sum(item => item.Connections), group.Sum(item => item.Bytes), group.Sum(item => item.ConnectionsWithoutBytes)))
                .OrderBy(item => item.Bucket).ThenBy(item => item.Application, StringComparer.Ordinal).ToList();

            var coverage = ReadCoverage(from, to);
            var monitoringStartText = NullableScalarText("SELECT MIN(started_at) FROM coverage_sessions");
            var monitoringStartedAt = DateTimeOffset.TryParse(monitoringStartText, out var started) ? started : (DateTimeOffset?)null;
            return new(from, to, connections, applications, destinations, bytes, unknown, coverage,
                monitoringStartedAt, ScalarInt64("SELECT COUNT(*) FROM flows"), links, timeline)
            {
                BucketCount = bucketCount,
                NamedDestinations = namedDestinations,
                NamedConnections = namedConnections,
                IncludesUnseparatedHours = unseparated,
                LocalConnections = localConnections,
                LocalDestinations = localDestinations,
                StorageBytes = ReadStorageBytes(),
                BytesSent = sent,
                BytesReceived = received,
                OutboundAnomalies = ReadOutboundAnomalyCountLocked(from, to),
                OutboundBaselineReady = ReadUsableBaselineWindowsLocked() >= 96,
                SleepPeriods = ReadSleepPeriodsLocked(from, to),
                MonitoringGaps = ReadMonitoringGaps(from, to),
            };
        }
    }

    private double ReadCoverage(DateTimeOffset from, DateTimeOffset to)
    {
        var covered = ReadCoveredIntervals(from, to);
        if (covered.Count == 0) return 0;
        var total = covered.Sum(interval => (interval.End - interval.Start).TotalSeconds);
        return Math.Clamp(total / (to - from).TotalSeconds, 0, 1);
    }

    /// What the period is missing, once sleep has been taken out of it.
    ///
    /// The ratio this used to be reduced to is true and easy to miss: a reader
    /// has to find the number, then work out that the rest of the period is
    /// not "no traffic" but "no record". The intervals were built either way,
    /// so the complement is given to the chart instead of being thrown away.
    ///
    /// Sleep is removed because it is already drawn. Two bands over the same
    /// minutes would make one outage look like two, and the one the user did
    /// not ask for is the one worth seeing.
    private IReadOnlyList<MonitoringGap> ReadMonitoringGaps(DateTimeOffset from, DateTimeOffset to)
    {
        if (to <= from) return [];
        var gaps = Complement(from, to, ReadCoveredIntervals(from, to));
        var sleeps = ReadSleepPeriodsLocked(from, to);
        if (sleeps.Count == 0)
            return gaps.Select(gap => new MonitoringGap(gap.Start, gap.End)).ToArray();

        var result = new List<MonitoringGap>();
        foreach (var gap in gaps)
        {
            var remaining = new List<(DateTimeOffset Start, DateTimeOffset End)> { gap };
            foreach (var sleep in sleeps)
            {
                var next = new List<(DateTimeOffset Start, DateTimeOffset End)>();
                foreach (var part in remaining)
                {
                    if (sleep.End <= part.Start || sleep.Start >= part.End) { next.Add(part); continue; }
                    if (sleep.Start > part.Start) next.Add((part.Start, sleep.Start));
                    if (sleep.End < part.End) next.Add((sleep.End, part.End));
                }
                remaining = next;
            }
            result.AddRange(remaining.Where(part => part.End > part.Start)
                .Select(part => new MonitoringGap(part.Start, part.End)));
        }
        return result;
    }

    private static List<(DateTimeOffset Start, DateTimeOffset End)> Complement(
        DateTimeOffset from, DateTimeOffset to, IReadOnlyList<(DateTimeOffset Start, DateTimeOffset End)> covered)
    {
        var gaps = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        var cursor = from;
        foreach (var interval in covered)
        {
            if (interval.Start > cursor) gaps.Add((cursor, interval.Start));
            if (interval.End > cursor) cursor = interval.End;
        }
        if (cursor < to) gaps.Add((cursor, to));
        return gaps;
    }

    /// The covered stretches, merged, clipped to the period.
    private List<(DateTimeOffset Start, DateTimeOffset End)> ReadCoveredIntervals(DateTimeOffset from, DateTimeOffset to)
    {
        var intervals = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        var sql = $"SELECT started_at,ended_at,confirmed_at FROM coverage_sessions WHERE started_at<'{to.ToUniversalTime():O}' AND COALESCE(ended_at,confirmed_at,started_at)>'{from.ToUniversalTime():O}' ORDER BY started_at";
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
            {
                var start = DateTimeOffset.Parse(Text(statement, 0));
                var endText = NullableTextValue(statement, 1);
                var confirmedText = NullableTextValue(statement, 2);
                var confirmed = confirmedText is null ? start : DateTimeOffset.Parse(confirmedText);
                var end = endText is not null
                    ? DateTimeOffset.Parse(endText)
                    : confirmed >= to || to - confirmed <= CoverageStaleAfter ? to : confirmed;
                intervals.Add((start < from ? from : start, end > to ? to : end));
            }
        }
        finally { WinSqlite.Finalize(statement); }
        if (intervals.Count == 0) return [];
        var merged = new List<(DateTimeOffset Start, DateTimeOffset End)>();
        var currentStart = intervals[0].Start;
        var currentEnd = intervals[0].End;
        foreach (var interval in intervals.Skip(1))
        {
            if (interval.Start <= currentEnd) { if (interval.End > currentEnd) currentEnd = interval.End; }
            else { merged.Add((currentStart, currentEnd)); currentStart = interval.Start; currentEnd = interval.End; }
        }
        merged.Add((currentStart, currentEnd));
        return merged;
    }

    public ThreatCacheState ReadThreatCacheState()
    {
        lock (gate)
        {
            CheckOperation(WinSqlite.Prepare(db, "SELECT availability,etag,fetched_at,(SELECT COUNT(*) FROM threat_indicators),source FROM threat_cache_state WHERE id=1", -1, out var statement, 0));
            try
            {
                CheckQueryRow(WinSqlite.Step(statement));
                var fetched = NullableTextValue(statement, 2);
                return new(Text(statement, 0), NullableTextValue(statement, 1),
                    fetched is null ? null : DateTimeOffset.Parse(fetched), WinSqlite.ColumnInt64(statement, 3),
                    Text(statement, 4));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    public void ReplaceThreatIndicators(bool available, IReadOnlyList<ThreatIndicator> indicators, string? etag,
        DateTimeOffset fetchedAt, string source = "hub")
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
                Execute($"UPDATE threat_cache_state SET availability='{(available ? "available" : "unavailable")}',etag={(etag is null ? "NULL" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}',source='{Sql(source)}' WHERE id=1");
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public void MarkThreatCacheFetched(string? etag, DateTimeOffset fetchedAt, string source = "hub")
    {
        // "Not modified" means the data in use is still whatever answered
        // last, so the source is recorded here too. Leaving it alone made the
        // screen say "none" for as long as the Hub kept returning 304 -- which
        // is most of the time, and exactly when everything is working.
        lock (gate) Execute($"UPDATE threat_cache_state SET etag={(etag is null ? "etag" : $"'{Sql(etag)}'")},fetched_at='{fetchedAt.ToUniversalTime():O}',source='{Sql(source)}' WHERE id=1");
    }

    public ThreatReport ReadThreatReport(DateTimeOffset from, DateTimeOffset to)
    {
        lock (gate)
        {
            var state = ReadThreatCacheState();
            if (state.Availability != "available") return new(state.Availability, state.IndicatorCount, state.FetchedAt, 0, []);
            var exact = new Dictionary<string, ThreatIndicator>(StringComparer.OrdinalIgnoreCase);
            var domains = new Dictionary<string, ThreatIndicator>(StringComparer.OrdinalIgnoreCase);
            var cidrs = new List<(uint Network, uint Mask, ThreatIndicator Indicator)>();
            CheckOperation(WinSqlite.Prepare(db, "SELECT kind,value,source,tag,confidence FROM threat_indicators", -1, out var indicatorStatement, 0));
            try
            {
                while (WinSqlite.Step(indicatorStatement) == WinSqlite.Row)
                {
                    var item = new ThreatIndicator(Text(indicatorStatement, 0), Text(indicatorStatement, 1),
                        NullableTextValue(indicatorStatement, 2), NullableTextValue(indicatorStatement, 3), Text(indicatorStatement, 4));
                    if (item.Kind == "ip") exact[item.Value] = item;
                    else if (item.Kind == "domain" && NormalizeDomain(item.Value) is { } domain) domains[domain] = item;
                    else if (item.Kind == "cidr" && TryParseCidr(item.Value, out var network, out var mask)) cidrs.Add((network, mask, item));
                }
            }
            finally { WinSqlite.Finalize(indicatorStatement); }

            var findings = new List<ThreatFinding>();
            // A PID is not an application. Keying nameless flows by their PID
            // made every unnamed process its own "application", so the count
            // reported thousands where the machine runs dozens. They all fold
            // into one bucket the reader can see and question instead.
            const string app = "COALESCE(NULLIF(process_name,''),'Unknown')";
            var sql = $"SELECT remote_address,remote_hostname,{app},COUNT(*),COALESCE(SUM(COALESCE(bytes_sent,0)+COALESCE(bytes_received,0)),0),SUM(CASE WHEN bytes_sent IS NULL OR bytes_received IS NULL THEN 1 ELSE 0 END),MIN(first_seen),MAX(last_seen) FROM flows WHERE last_seen>='{from.ToUniversalTime():O}' AND first_seen<'{to.ToUniversalTime():O}' AND layer='logical' GROUP BY 1,2,3 ORDER BY 4 DESC";
            CheckOperation(WinSqlite.Prepare(db, sql, -1, out var candidateStatement, 0));
            var checkedDestinations = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var domainChecked = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            try
            {
                while (WinSqlite.Step(candidateStatement) == WinSqlite.Row)
                {
                    var address = Text(candidateStatement, 0);
                    var hostname = NormalizeDomain(NullableTextValue(candidateStatement, 1));
                    checkedDestinations.Add(address);
                    if (hostname is not null) domainChecked.Add(address);
                    ThreatIndicator? match = exact.GetValueOrDefault(address);
                    string? matchedValue = match?.Value;
                    if (match is null && hostname is not null)
                    {
                        foreach (var candidate in DomainCandidates(hostname))
                        {
                            if (!domains.TryGetValue(candidate, out match)) continue;
                            matchedValue = candidate;
                            break;
                        }
                    }
                    if (match is null && TryIpv4(address, out var number))
                    {
                        match = cidrs.FirstOrDefault(item => (number & item.Mask) == item.Network).Indicator;
                        matchedValue = match?.Value;
                    }
                    if (match is null) continue;
                    var destination = match.Kind == "domain" ? $"{hostname} ({address})" : address;
                    findings.Add(new(destination, address, hostname, Text(candidateStatement, 2), WinSqlite.ColumnInt64(candidateStatement, 3),
                        WinSqlite.ColumnInt64(candidateStatement, 4), WinSqlite.ColumnInt64(candidateStatement, 5),
                        DateTimeOffset.Parse(Text(candidateStatement, 6)), DateTimeOffset.Parse(Text(candidateStatement, 7)),
                        match.Kind, matchedValue ?? match.Value, match.Source, match.Tag, match.Confidence));
                }
            }
            finally { WinSqlite.Finalize(candidateStatement); }
            return new(state.Availability, state.IndicatorCount, state.FetchedAt, checkedDestinations.Count, findings)
            {
                DomainCheckedDestinations = domainChecked.Count,
                DomainUncheckedDestinations = checkedDestinations.Count - domainChecked.Count,
            };
        }
    }

    private static IEnumerable<string> DomainCandidates(string hostname)
    {
        yield return hostname;
        var labels = hostname.Split('.');
        for (var index = 1; index <= labels.Length - 2; index++) yield return string.Join('.', labels[index..]);
    }

    private static string? NormalizeDomain(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var trimmed = value.Trim().TrimEnd('.');
        if (!trimmed.Contains('.') || IPAddress.TryParse(trimmed, out _)) return null;
        try { return new System.Globalization.IdnMapping().GetAscii(trimmed).ToLowerInvariant(); }
        catch (ArgumentException) { return null; }
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

    /// The detail column of EXPLAIN QUERY PLAN, joined, for asserting on.
    private string QueryPlan(string sql)
    {
        CheckOperation(WinSqlite.Prepare(db, "EXPLAIN QUERY PLAN " + sql, -1, out var statement, 0));
        try
        {
            var lines = new List<string>();
            while (WinSqlite.Step(statement) == WinSqlite.Row)
                lines.Add(Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, 3)) ?? string.Empty);
            return string.Join("; ", lines);
        }
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

    internal void FailHistoryDeletionForTesting(bool enabled)
    {
        lock (gate)
        {
            if (enabled)
                Execute("CREATE TEMP TRIGGER IF NOT EXISTS fail_history_delete BEFORE DELETE ON flows BEGIN SELECT RAISE(ABORT,'simulated deletion interruption'); END");
            else Execute("DROP TRIGGER IF EXISTS fail_history_delete");
        }
    }

    /// <param name="extraSql">
    /// Run after the v1 schema, to set up a migration that cannot succeed.
    /// A failure has to be caused before it can be reported, and there is no
    /// honest way to cause one from outside: the report would otherwise be a
    /// path nothing executes.
    /// </param>
    /// Writes a folded hour directly, including one the Agent could not
    /// separate.
    ///
    /// 'mixed' rows are made by the v27-to-v28 migration and by nothing else,
    /// so without this there is no way to reach the code that reads them: the
    /// timeline has to keep counting them, and the window has to say they are
    /// there. Both are behaviour a reader sees for thirty days after an
    /// upgrade, and neither could be exercised.
    internal void SeedFoldedHourForTesting(DateTimeOffset bucket, string application, string scope,
        long connections, long bytes)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            Execute($"INSERT INTO chart_hourly(bucket_start,application,layer,scope,observation_count,flow_count,bytes_sent,bytes_received,bytes_unknown) "
                + $"VALUES('{bucket.ToUniversalTime():O}','{Sql(application)}','logical','{Sql(scope)}',{connections},{connections},{bytes},0,0)");
        }
    }

    internal static void CreateVersion1FixtureForTesting(string fixturePath, string? extraSql = null)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(fixturePath))!);
        Check(WinSqlite.Open(fixturePath, out var fixtureDb, WinSqlite.OpenReadWrite | WinSqlite.OpenCreate | WinSqlite.OpenFullMutex, 0));
        try
        {
            // With rows in it. An empty fixture migrates through every
            // version without touching a single row of data, which is the
            // half of a migration that cannot go wrong.
            var code = WinSqlite.Exec(fixtureDb, extraSql + $"""
                PRAGMA journal_mode=WAL; {Version1Schema}
                INSERT INTO observations(observed_at,process_id,protocol,local_address,local_port,
                  remote_address,remote_port,bytes_sent,bytes_received,layer,interface_id,source)
                VALUES('2020-01-01T00:00:00.1234567+00:00',4242,'TCP','10.1.1.1',50000,'93.184.216.34',443,1024,2048,'logical','iface-1','etw'),
                      ('2020-01-01T00:00:01.0000000+00:00',4242,'TCP','10.1.1.1',50000,'93.184.216.34',443,512,256,'logical','iface-1','etw'),
                      ('2020-01-01T00:00:02.0000000+00:00',77,'UDP','10.1.1.1',5353,'224.0.0.251',5353,64,0,'logical','iface-1','etw'),
                      ('2020-01-01T00:00:03.0000000+00:00',77,'UDP','10.1.1.1',5353,'239.255.255.250',1900,32,0,'logical','iface-1','etw');
                """, 0, 0, out var error);
            if (error != 0) WinSqlite.Free(error);
            Check(code);
        }
        finally { WinSqlite.Close(fixtureDb); }
    }
}
