using System.Net;
using System.Runtime.InteropServices;

namespace EgressView.Agent.Core;

public sealed record DeliveryObservation(
    Guid ObservationId, string NetworkProtocol, string LocalAddress, int LocalPort,
    string RemoteAddress, int RemotePort, int ProcessId, string ProcessName,
    DateTimeOffset FirstObservedAt, DateTimeOffset LastObservedAt, long? BytesIn, long? BytesOut,
    string Collector = "etw", string Confidence = "exact", string? BundleID = null);

public sealed record DeliveryBatch(Guid BatchId, DateTimeOffset SentAt, IReadOnlyList<DeliveryObservation> Observations);
public sealed record DeliveryQueueStatus(long Pending, long ContractRejected, long QueueOverflow,
    DateTimeOffset? OldestPendingAt, DateTimeOffset? LastAcknowledgedAt);

public sealed partial class ObservationStore
{
    public void QueueForDelivery(IReadOnlyList<NetworkObservation> observations, DateTimeOffset queuedAt, int maximumPending = 10_000)
    {
        if (observations.Count == 0) return;
        if (maximumPending < 1) throw new ArgumentOutOfRangeException(nameof(maximumPending));
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
                foreach (var item in observations)
                {
                    if (item.Layer != ObservationLayer.Logical) continue;
                    if (!IsDeliverable(item))
                    {
                        Execute("UPDATE delivery_state SET contract_rejected=contract_rejected+1 WHERE id=1");
                        continue;
                    }
                    var id = Guid.NewGuid().ToString("D");
                    var stable = Sql(StartupSnapshot.FlowKey(item.Protocol, item.LocalAddress, item.LocalPort,
                        item.RemoteAddress, item.RemotePort, item.ProcessId));
                    var process = Sql(item.ProcessName!);
                    var first = item.ObservedAt.ToUniversalTime().ToString("O");
                    var sent = item.BytesSent?.ToString() ?? "NULL";
                    var received = item.BytesReceived?.ToString() ?? "NULL";
                    Execute($"""
                        INSERT INTO delivery_queue(delivery_id,stable_key,protocol,local_address,local_port,remote_address,remote_port,
                          process_id,process_name,first_observed_at,last_observed_at,bytes_in,bytes_out,queued_at,batch_id)
                        VALUES('{id}','{stable}','{item.Protocol.ToLowerInvariant()}','{Sql(item.LocalAddress)}',{item.LocalPort},
                          '{Sql(item.RemoteAddress)}',{item.RemotePort},{item.ProcessId},'{process}','{first}','{first}',{received},{sent},'{queuedAt.ToUniversalTime():O}',NULL)
                        ON CONFLICT(stable_key) WHERE batch_id IS NULL DO UPDATE SET
                          last_observed_at=excluded.last_observed_at,process_name=excluded.process_name,
                          bytes_in=CASE WHEN delivery_queue.bytes_in IS NULL OR excluded.bytes_in IS NULL THEN NULL ELSE delivery_queue.bytes_in+excluded.bytes_in END,
                          bytes_out=CASE WHEN delivery_queue.bytes_out IS NULL OR excluded.bytes_out IS NULL THEN NULL ELSE delivery_queue.bytes_out+excluded.bytes_out END
                        """);
                }
                var overflow = Math.Max(0, ScalarInt64("SELECT COUNT(*) FROM delivery_queue") - maximumPending);
                if (overflow > 0)
                {
                    Execute($"DELETE FROM delivery_queue WHERE delivery_id IN (SELECT delivery_id FROM delivery_queue WHERE batch_id IS NULL ORDER BY queued_at LIMIT {overflow})");
                    var removed = Math.Max(0, overflow - Math.Max(0, ScalarInt64("SELECT COUNT(*) FROM delivery_queue") - maximumPending));
                    if (removed > 0) Execute($"UPDATE delivery_state SET queue_overflow=queue_overflow+{removed} WHERE id=1");
                }
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public DeliveryBatch? PrepareDeliveryBatch(DateTimeOffset sentAt, int limit = 200)
    {
        limit = Math.Clamp(limit, 1, 200);
        lock (gate)
        {
            Execute("BEGIN IMMEDIATE");
            try
            {
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
                Execute($"UPDATE delivery_state SET last_acknowledged_at='{acknowledgedAt.ToUniversalTime():O}' WHERE id=1");
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
        }
    }

    public DeliveryQueueStatus ReadDeliveryStatus()
    {
        lock (gate)
        {
            var oldest = ScalarTextOrNull("SELECT MIN(queued_at) FROM delivery_queue");
            var acknowledged = ScalarTextOrNull("SELECT last_acknowledged_at FROM delivery_state WHERE id=1");
            return new(ScalarInt64("SELECT COUNT(*) FROM delivery_queue"),
                ScalarInt64("SELECT contract_rejected FROM delivery_state WHERE id=1"),
                ScalarInt64("SELECT queue_overflow FROM delivery_state WHERE id=1"),
                oldest is null ? null : DateTimeOffset.Parse(oldest), acknowledged is null ? null : DateTimeOffset.Parse(acknowledged));
        }
    }

    private IReadOnlyList<DeliveryObservation> ReadDeliveryBatch(Guid batchId)
    {
        var result = new List<DeliveryObservation>();
        CheckOperation(WinSqlite.Prepare(db, $"SELECT delivery_id,protocol,local_address,local_port,remote_address,remote_port,process_id,process_name,first_observed_at,last_observed_at,bytes_in,bytes_out FROM delivery_queue WHERE batch_id='{batchId:D}' ORDER BY queued_at", -1, out var statement, 0));
        try
        {
            while (true)
            {
                var code = WinSqlite.Step(statement);
                if (code == WinSqlite.Done) break;
                CheckQueryRow(code);
                result.Add(new(Guid.Parse(Text(statement, 0)), Text(statement, 1), Text(statement, 2), (int)WinSqlite.ColumnInt64(statement, 3),
                    Text(statement, 4), (int)WinSqlite.ColumnInt64(statement, 5), (int)WinSqlite.ColumnInt64(statement, 6), Text(statement, 7),
                    DateTimeOffset.Parse(Text(statement, 8)), DateTimeOffset.Parse(Text(statement, 9)), NullableInt64(statement, 10), NullableInt64(statement, 11)));
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
    private static bool IsDeliverable(NetworkObservation item) => item.RemotePort is > 0 and <= 65535
        && item.LocalPort is >= 0 and <= 65535 && IPAddress.TryParse(item.LocalAddress, out _) && IPAddress.TryParse(item.RemoteAddress, out _)
        && item.ProcessId >= 0 && item.ProcessName is { Length: > 0 and <= 256 } name && !name.Any(char.IsControl);
}
