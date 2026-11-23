using System.Net;
using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

public sealed record DeliveryObservation(
    Guid ObservationId, string NetworkProtocol, string LocalAddress, int LocalPort,
    string RemoteAddress, int RemotePort, int ProcessId, string ProcessName,
    DateTimeOffset FirstObservedAt, DateTimeOffset LastObservedAt, long? BytesIn, long? BytesOut,
    string Collector = "etw", string Confidence = "exact", string? BundleID = null, string? RemoteHostname = null);

public sealed record DeliveryBatch(Guid BatchId, DateTimeOffset SentAt, IReadOnlyList<DeliveryObservation> Observations);
/// What a refusal did to the batch it was about.
public enum DeliveryRefusal
{
    /// The batch was halved; the released half returns to the queue.
    Split,
    /// A single observation, kept for another attempt.
    Retained,
    /// A single observation the Hub refused often enough to give up on.
    Abandoned,
    /// Nothing was claimed under that id. Says only that the refusal arrived
    /// after the batch had already gone, which is not an error.
    Unknown,
}

public sealed record DeliveryQueueStatus(long Pending, long ContractRejected, long QueueOverflow,
    DateTimeOffset? OldestPendingAt, DateTimeOffset? LastAcknowledgedAt);

public sealed partial class ObservationStore
{
    public bool DeliveryEnabled
    {
        get { lock (gate) return ScalarInt64("SELECT delivery_enabled FROM delivery_state WHERE id=1") == 1; }
        set { lock (gate) Execute($"UPDATE delivery_state SET delivery_enabled={(value ? 1 : 0)} WHERE id=1"); }
    }

    public void QueueForDelivery(IReadOnlyList<NetworkObservation> observations, DateTimeOffset queuedAt, int maximumPending = 10_000)
    {
        if (observations.Count == 0) return;
        if (maximumPending < 1) throw new ArgumentOutOfRangeException(nameof(maximumPending));
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                QueueForDeliveryWithinTransaction(observations, queuedAt, maximumPending);
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    internal void QueueForDeliveryWithinTransaction(IReadOnlyList<NetworkObservation> observations, DateTimeOffset queuedAt, int maximumPending)
    {
        foreach (var item in observations)
        {
            if (item.Layer != ObservationLayer.Logical) continue;
            if (RejectionReason(item) is { } reason)
            {
                Execute("UPDATE delivery_state SET contract_rejected=contract_rejected+1 WHERE id=1");
                // The total says how much never reaches the Hub; only the
                // reason says what to fix. Without it, a name that could be
                // recovered and a port that never can look identical.
                Execute($"INSERT INTO collector_counters(name,value) VALUES('contract-rejected-{reason}',1) " +
                        "ON CONFLICT(name) DO UPDATE SET value=value+1");
                continue;
            }
            var id = Guid.NewGuid().ToString("D");
            var instanceId = item.ProcessInstanceId ?? $"legacy:pid:{item.ProcessId}:name:{item.ProcessName ?? "unknown"}";
            var stable = Sql(StartupSnapshot.FlowKey(item.Protocol, item.LocalAddress, item.LocalPort, item.RemoteAddress, item.RemotePort, item.ProcessId, instanceId));
            var first = item.ObservedAt.ToUniversalTime().ToString("O");
            var sent = item.BytesSent?.ToString() ?? "NULL";
            var received = item.BytesReceived?.ToString() ?? "NULL";
            Execute($"""
                INSERT INTO delivery_queue(delivery_id,stable_key,protocol,local_address,local_port,remote_address,remote_port,process_id,process_name,first_observed_at,last_observed_at,bytes_in,bytes_out,queued_at,batch_id,remote_hostname,process_instance_id)
                VALUES('{id}','{stable}','{item.Protocol.ToLowerInvariant()}','{Sql(item.LocalAddress)}',{item.LocalPort},'{Sql(item.RemoteAddress)}',{item.RemotePort},{item.ProcessId},'{Sql(item.ProcessName!)}','{first}','{first}',{received},{sent},'{queuedAt.ToUniversalTime():O}',NULL,{(item.RemoteHostname is null ? "NULL" : $"'{Sql(item.RemoteHostname)}'")},'{Sql(instanceId)}')
                ON CONFLICT(stable_key) WHERE batch_id IS NULL DO UPDATE SET first_observed_at=MIN(delivery_queue.first_observed_at,excluded.first_observed_at),last_observed_at=MAX(delivery_queue.last_observed_at,excluded.last_observed_at),process_name=excluded.process_name,remote_hostname=COALESCE(excluded.remote_hostname,delivery_queue.remote_hostname),bytes_in=CASE WHEN delivery_queue.bytes_in IS NULL OR excluded.bytes_in IS NULL THEN NULL ELSE delivery_queue.bytes_in+excluded.bytes_in END,bytes_out=CASE WHEN delivery_queue.bytes_out IS NULL OR excluded.bytes_out IS NULL THEN NULL ELSE delivery_queue.bytes_out+excluded.bytes_out END
                """);
        }
        var overflow = Math.Max(0, ScalarInt64("SELECT COUNT(*) FROM delivery_queue") - maximumPending);
        if (overflow <= 0) return;
        // Set aside, not deleted: they have never been sent, so they can go
        // later under the same id without the Hub counting anything twice.
        // The same rows both times: ordered to the last tie (by rowid, which
        // the batch index already carries, so it is not sorted), so the second
        // select cannot pick a row the first one did not copy. Matched against
        // what was just chosen, not against the whole spill, which at its
        // bound made every write of a few observations take some 40 ms.
        var oldest = $"SELECT delivery_id FROM delivery_queue WHERE batch_id IS NULL ORDER BY queued_at, rowid LIMIT {overflow}";
        Execute($"INSERT OR IGNORE INTO delivery_spill({SpillColumns}) SELECT {SpillColumns} FROM delivery_queue WHERE delivery_id IN ({oldest})");
        var moved = DeleteWhere("delivery_queue", $"delivery_id IN ({oldest})");
        if (moved > 0) Execute($"INSERT INTO collector_counters(name,value) VALUES('delivery-observations-spilled',{moved}) " +
                               "ON CONFLICT(name) DO UPDATE SET value=value+excluded.value");
        // Bounded too. Past this, the oldest are lost, and counted as before.
        var excess = ScalarInt64("SELECT COUNT(*) FROM delivery_spill") - SpillCapacity;
        if (excess <= 0) return;
        Execute($"DELETE FROM delivery_spill WHERE delivery_id IN (SELECT delivery_id FROM delivery_spill ORDER BY queued_at LIMIT {excess})");
        Execute($"UPDATE delivery_state SET queue_overflow=queue_overflow+{excess} WHERE id=1");
    }

    /// Where the queue's overflow waits. On 2026-11-15 a queue held at its
    /// limit for five hours by a blocked batch deleted 66,847 observations
    /// the Hub never received; held here, they would have gone once delivery
    /// moved again. Measured at the bound (2026-11-23), the queue and the
    /// spill together took 89 MB, about 420 bytes a row with their indexes,
    /// and nothing in it outlives the Hub's seven days.
    public const int SpillCapacity = 200_000;
    public const int DeliveryQueueCapacity = 10_000;

    private const string SpillColumns = "delivery_id,stable_key,protocol,local_address,local_port,remote_address,remote_port,process_id,process_name," +
        "first_observed_at,last_observed_at,bytes_in,bytes_out,queued_at,remote_hostname,process_instance_id";

    private const string Version34Schema = """
        CREATE TABLE IF NOT EXISTS delivery_spill(
          delivery_id TEXT PRIMARY KEY,
          stable_key TEXT NOT NULL,
          protocol TEXT NOT NULL,
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
          remote_hostname TEXT,
          process_instance_id TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS delivery_spill_queued ON delivery_spill(queued_at);
        """;

    /// No backup: one new table, empty, in one transaction.
    private void MigrateVersion33To34()
    {
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version34Schema + " UPDATE schema_version SET version=34 WHERE version=33; COMMIT;");
        }
        catch { TryRollback(); throw; }
    }

    /// Brings set-aside observations back once the queue has room for a whole
    /// batch of them, oldest first, so they go before what came after them.
    /// One already waiting for the same flow takes them in, as a new
    /// observation of that flow would be.
    private void RefillFromSpillLocked(int limit)
    {
        if (DeliveryQueueCapacity - ScalarInt64("SELECT COUNT(*) FROM delivery_queue") < limit) return;
        var ids = new List<string>();
        CheckOperation(WinSqlite.Prepare(db, $"SELECT delivery_id FROM delivery_spill ORDER BY queued_at LIMIT {limit}", -1, out var statement, 0));
        try { while (WinSqlite.Step(statement) == WinSqlite.Row) ids.Add(Text(statement, 0)); }
        finally { WinSqlite.Finalize(statement); }
        if (ids.Count == 0) return;
        var list = string.Join(',', ids.Select(id => $"'{Sql(id)}'"));
        Execute($"""
            INSERT INTO delivery_queue({SpillColumns},batch_id)
            SELECT {SpillColumns},NULL FROM delivery_spill WHERE delivery_id IN ({list}) AND 1
            ON CONFLICT(stable_key) WHERE batch_id IS NULL DO UPDATE SET first_observed_at=MIN(delivery_queue.first_observed_at,excluded.first_observed_at),last_observed_at=MAX(delivery_queue.last_observed_at,excluded.last_observed_at),remote_hostname=COALESCE(delivery_queue.remote_hostname,excluded.remote_hostname),bytes_in=CASE WHEN delivery_queue.bytes_in IS NULL OR excluded.bytes_in IS NULL THEN NULL ELSE delivery_queue.bytes_in+excluded.bytes_in END,bytes_out=CASE WHEN delivery_queue.bytes_out IS NULL OR excluded.bytes_out IS NULL THEN NULL ELSE delivery_queue.bytes_out+excluded.bytes_out END
            """);
        Execute($"DELETE FROM delivery_spill WHERE delivery_id IN ({list})");
    }

    /// How old an observation may be and still be taken by the Hub, which
    /// refuses anything last seen more than seven days before it arrives
    /// (`AGENT_INGEST_DEFAULT_RETENTION_MS`). An hour short of that, for the
    /// clocks on the two sides and the time a batch spends on its way.
    public static readonly TimeSpan HubAcceptsFor = TimeSpan.FromDays(7) - TimeSpan.FromHours(1);

    public DeliveryBatch? PrepareDeliveryBatch(DateTimeOffset sentAt, int limit = 200)
    {
        limit = Math.Clamp(limit, 1, 200);
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                DropObservationsTheHubWillRefuseLocked(sentAt);
                RefillFromSpillLocked(limit);
                var existing = ScalarTextOrNull("SELECT batch_id FROM delivery_queue WHERE batch_id IS NOT NULL ORDER BY queued_at LIMIT 1");
                var batchId = existing is null ? Guid.NewGuid() : Guid.Parse(existing);
                if (existing is null)
                    Execute($"UPDATE delivery_queue SET batch_id='{batchId:D}' WHERE delivery_id IN (SELECT delivery_id FROM delivery_queue WHERE batch_id IS NULL ORDER BY queued_at LIMIT {limit})");
                var items = ReadDeliveryBatch(batchId);
                Execute("COMMIT");
                return items.Count == 0 ? null : new(batchId, sentAt, items);
            }
            catch { TryRollback(); throw; }
        }
    }

    /// Takes out what the Hub would refuse for its age, before it is sent.
    ///
    /// A PC shut down for nine days came back with 290 of 9,509 queued
    /// observations past the Hub's seven days (2026-11-15). The Hub refuses a
    /// batch with any of them in it, and narrowing a refusal down to one
    /// observation and giving that one five tries takes about half an hour
    /// each: about six days before the rest of the queue moved again. Their
    /// age is known here, so they go now, and how many is counted.
    private void DropObservationsTheHubWillRefuseLocked(DateTimeOffset sentAt)
    {
        var cutoff = (sentAt - HubAcceptsFor).ToUniversalTime().ToString("O");
        var expired = ScalarInt64($"SELECT COUNT(*) FROM delivery_queue WHERE last_observed_at<'{cutoff}'")
            + DeleteWhere("delivery_spill", $"last_observed_at<'{cutoff}'");
        if (expired == 0) return;
        var claimed = ScalarInt64($"SELECT COUNT(*) FROM delivery_queue WHERE last_observed_at<'{cutoff}' AND batch_id IS NOT NULL");
        Execute($"DELETE FROM delivery_queue WHERE last_observed_at<'{cutoff}'");
        // What is left of a refused batch is a different batch, with its
        // tries still to come.
        if (claimed > 0) Execute("UPDATE delivery_state SET blocked_batch_rejections=0 WHERE id=1");
        Execute($"INSERT INTO collector_counters(name,value) VALUES('delivery-observations-expired',{expired}) " +
                "ON CONFLICT(name) DO UPDATE SET value=value+excluded.value");
    }

    /// How many times a single observation may be refused before it is given
    /// up on.
    ///
    /// Only ever applied to a batch of one, because by then the refusal is
    /// about that observation and nothing else. Not one refusal, because
    /// "rejected" has arrived from a Hub that was mid-deploy, and throwing
    /// data away on a single answer would make a restart of the other side
    /// into data loss here.
    public const int AbandonBatchAfterRejections = 5;

    /// Records that the Hub refused this batch, and narrows the refusal to the
    /// observation responsible.
    ///
    /// Discarding the batch was the first answer, and the measurement said it
    /// was too blunt: on a real machine it unblocked delivery and then shed
    /// 200 observations every two and a half minutes, because one record the
    /// Hub would not take condemned the 199 innocent ones travelling with it.
    /// Roughly 4,800 an hour, against a Hub that was answering normally the
    /// rest of the time.
    ///
    /// So a refused batch is halved instead. The half that is kept carries the
    /// batch on; the half that is released goes back to the queue to be sent
    /// with everything else. Eight halvings take two hundred observations down
    /// to one, and only that one is ever given up on.
    ///
    /// Only for refusals of the content itself. A network failure, a rate
    /// limit or an expired credential says nothing about the batch and must
    /// not consume its lives: an Agent offline for an afternoon has to come
    /// back with its queue intact.
    public DeliveryRefusal RecordDeliveryBatchRejection(Guid batchId)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                var size = ScalarInt64($"SELECT COUNT(*) FROM delivery_queue WHERE batch_id='{batchId:D}'");
                if (size == 0)
                {
                    Execute("COMMIT");
                    return DeliveryRefusal.Unknown;
                }
                if (size > 1)
                {
                    // The younger half goes back. Ordering by queued_at keeps
                    // the oldest observations moving first, which is the order
                    // everything else in the queue is served in.
                    var release = size / 2;
                    Execute($"""
                        UPDATE delivery_queue SET batch_id=NULL
                        WHERE delivery_id IN (
                          SELECT delivery_id FROM delivery_queue WHERE batch_id='{batchId:D}'
                          ORDER BY queued_at DESC, delivery_id DESC LIMIT {release})
                        """);
                    // The tally starts again: what is left is a different
                    // batch in everything but name, and has not been refused.
                    Execute($"UPDATE delivery_state SET blocked_batch_id='{batchId:D}',blocked_batch_rejections=0 WHERE id=1");
                    Execute("COMMIT");
                    AddCounter("delivery-batches-split", 1);
                    return DeliveryRefusal.Split;
                }

                var blocked = ScalarTextOrNull("SELECT blocked_batch_id FROM delivery_state WHERE id=1");
                var rejections = string.Equals(blocked, batchId.ToString("D"), StringComparison.OrdinalIgnoreCase)
                    ? ScalarInt64("SELECT blocked_batch_rejections FROM delivery_state WHERE id=1") + 1
                    : 1;
                if (rejections < AbandonBatchAfterRejections)
                {
                    Execute($"UPDATE delivery_state SET blocked_batch_id='{batchId:D}',blocked_batch_rejections={rejections} WHERE id=1");
                    Execute("COMMIT");
                    return DeliveryRefusal.Retained;
                }
                // Said in the durable counters, not dropped quietly. One
                // observation is a small loss; a loss nobody can count is not.
                Execute($"DELETE FROM delivery_queue WHERE batch_id='{batchId:D}'");
                Execute("UPDATE delivery_state SET blocked_batch_id=NULL,blocked_batch_rejections=0 WHERE id=1");
                Execute("COMMIT");
                AddCounter("delivery-batch-abandoned", 1);
                AddCounter("delivery-observations-abandoned", 1);
                return DeliveryRefusal.Abandoned;
            }
            catch { TryRollback(); throw; }
        }
    }

    public void AcknowledgeDelivery(Guid batchId, DateTimeOffset acknowledgedAt)
    {
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                if (ScalarInt64($"SELECT COUNT(*) FROM delivery_queue WHERE batch_id='{batchId:D}'") == 0)
                    throw new InvalidOperationException("Acknowledgement does not match the active delivery batch.");
                Execute($"DELETE FROM delivery_queue WHERE batch_id='{batchId:D}'");
                Execute($"UPDATE delivery_state SET last_acknowledged_at='{acknowledgedAt.ToUniversalTime():O}',blocked_batch_id=NULL,blocked_batch_rejections=0 WHERE id=1");
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public DeliveryQueueStatus ReadDeliveryStatus()
    {
        lock (gate)
        {
            // What was set aside is still waiting to be sent.
            var oldest = ScalarTextOrNull("SELECT MIN(queued_at) FROM (SELECT queued_at FROM delivery_queue UNION ALL SELECT queued_at FROM delivery_spill)");
            var acknowledged = ScalarTextOrNull("SELECT last_acknowledged_at FROM delivery_state WHERE id=1");
            return new(ScalarInt64("SELECT (SELECT COUNT(*) FROM delivery_queue) + (SELECT COUNT(*) FROM delivery_spill)"),
                ScalarInt64("SELECT contract_rejected FROM delivery_state WHERE id=1"),
                ScalarInt64("SELECT queue_overflow FROM delivery_state WHERE id=1"),
                oldest is null ? null : DateTimeOffset.Parse(oldest), acknowledged is null ? null : DateTimeOffset.Parse(acknowledged));
        }
    }

    public AgentUninstallResult CompleteUninstallPreparation(bool removeLocalHistory, bool hubRevoked, bool continuedWithoutRevocation, DateTimeOffset now)
    {
        lock (gate)
        {
            ThrowIfDisposed();
            Execute("BEGIN IMMEDIATE");
            try
            {
                Execute("UPDATE delivery_state SET delivery_enabled=0 WHERE id=1");
                var pending = DeleteWhere("delivery_queue", "1=1") + DeleteWhere("delivery_spill", "1=1");
                if (removeLocalHistory) DeleteLocalHistoryWithinTransaction(now.ToUniversalTime());
                Execute("COMMIT");
                return new(hubRevoked, continuedWithoutRevocation, removeLocalHistory, pending);
            }
            catch { TryRollback(); throw; }
        }
    }

    private IReadOnlyList<DeliveryObservation> ReadDeliveryBatch(Guid batchId)
    {
        var result = new List<DeliveryObservation>();
        CheckOperation(WinSqlite.Prepare(db, $"SELECT delivery_id,protocol,local_address,local_port,remote_address,remote_port,process_id,process_name,first_observed_at,last_observed_at,bytes_in,bytes_out,remote_hostname FROM delivery_queue WHERE batch_id='{batchId:D}' ORDER BY queued_at", -1, out var statement, 0));
        try
        {
            while (true)
            {
                var code = WinSqlite.Step(statement);
                if (code == WinSqlite.Done) break;
                CheckQueryRow(code);
                result.Add(new(Guid.Parse(Text(statement, 0)), Text(statement, 1), Text(statement, 2), (int)WinSqlite.ColumnInt64(statement, 3),
                    Text(statement, 4), (int)WinSqlite.ColumnInt64(statement, 5), (int)WinSqlite.ColumnInt64(statement, 6), Text(statement, 7),
                    DateTimeOffset.Parse(Text(statement, 8)), DateTimeOffset.Parse(Text(statement, 9)), NullableInt64(statement, 10), NullableInt64(statement, 11),
                    RemoteHostname: NullableTextValue(statement, 12)));
            }
        }
        finally { WinSqlite.Finalize(statement); }
        return result;
    }

    private string? ScalarTextOrNull(string sql)
    {
        CheckOperation(WinSqlite.Prepare(db, sql, -1, out var statement, 0));
        try
        {
            var code = WinSqlite.Step(statement);
            if (code == WinSqlite.Done) return null;
            CheckQueryRow(code);
            var pointer = WinSqlite.ColumnText(statement, 0);
            return pointer == 0 ? null : Marshal.PtrToStringUTF8(pointer);
        }
        finally { WinSqlite.Finalize(statement); }
    }

    private static string Text(nint statement, int column) => Marshal.PtrToStringUTF8(WinSqlite.ColumnText(statement, column))!;
    private static long? NullableInt64(nint statement, int column) => WinSqlite.ColumnType(statement, column) == 5 ? null : WinSqlite.ColumnInt64(statement, column);
    /// Why the Hub would refuse this observation, or null when it would not.
    ///
    /// The reason is the counter name, so the breakdown arrives in diagnostics
    /// through the existing durable counters. Names are deliberately coarse:
    /// they say which part of the contract failed, never what the value was.
    private static string? RejectionReason(NetworkObservation item)
    {
        if (item.RemotePort is <= 0 or > 65535) return "remote-port";
        if (item.LocalPort is < 0 or > 65535) return "local-port";
        // An inbound group datagram names the sender and the group but not the
        // interface that received it, so the collector leaves the local address
        // empty rather than inventing one. That is a deliberate omission, not a
        // malformed observation, and calling it "local-address" alongside real
        // contract failures buries the ones worth fixing.
        if (item.LocalAddress.Length == 0) return "inbound-multicast-no-local-address";
        if (!IPAddress.TryParse(item.LocalAddress, out _)) return "local-address";
        if (!IPAddress.TryParse(item.RemoteAddress, out _)) return "remote-address";
        if (item.ProcessId < 0) return "process-id";
        if (item.ProcessName is not { Length: > 0 and <= 256 } name) return "process-name";
        if (name.Any(char.IsControl)) return "process-name";
        return null;
    }
}
