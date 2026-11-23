using System.Text.Json;

namespace EgressView.Agent.Core;

/// One change in how delivery to the Hub is going.
///
/// State is from DeliveryController's fixed vocabulary ("acknowledged",
/// "retryable", "rate-limited", ..., and "start" for a service start), the
/// status code is the Hub's, Network is Windows' own judgment at that moment
/// (WindowsNetwork.Code), and the times are the Agent's. Nothing names the Hub
/// or a destination.
public sealed record DeliveryEvent(DateTimeOffset At, string State, int? StatusCode, long Pending,
    DateTimeOffset? LastAcknowledgedAt, string? Network);

/// The changes, kept in a small file beside the database.
///
/// On 2026-11-21 a notice said delivery had stopped, and afterwards nothing on
/// the PC could say when the Hub last took a batch: acknowledgements came every
/// two seconds and none of them was written down. Recording every one would
/// be a write every two seconds for nothing; recording the changes is a
/// handful a day, and each failure carries the last acknowledgement before it.
///
/// A file rather than a table, like service-starts.json: it needs no schema
/// change, survives the database being replaced, and is read the same way.
public sealed class DeliveryHistory(string dataDirectory)
{
    public const string FileName = "delivery-history.json";

    /// Bounded. At a few changes a day this is weeks; a Hub that flaps every
    /// minute fills it in a few hours, and the newest are what is asked about.
    public const int Kept = 200;

    private readonly object gate = new();
    private DeliveryEvent? last = Read(dataDirectory).LastOrDefault();

    /// Records the outcome of an attempt if it differs from the last one
    /// recorded: success to failure, one failure to another, a different
    /// status code, or back. The queue and the network are read only when an
    /// event is written, so an attempt that changes nothing costs nothing.
    /// Returns whether it wrote one.
    public bool Observe(DateTimeOffset at, string state, int? statusCode,
        Func<(long Pending, DateTimeOffset? LastAcknowledgedAt)> queue, Func<PcNetwork> network)
    {
        var outcome = Outcome(state);
        if (outcome is null) return false;
        lock (gate)
        {
            if (last is not null && Outcome(last.State) == outcome && last.StatusCode == statusCode) return false;
            var failed = DeliveryNotificationTracker.IsFailure(state);
            var (pending, lastAcknowledgedAt) = queue();
            Append(new DeliveryEvent(at, state, statusCode, pending, lastAcknowledgedAt,
                failed ? WindowsNetwork.Code(network()) : null));
            return true;
        }
    }

    /// A service start, so the gaps between runs are not read as delivery
    /// having been fine or broken the whole time.
    public void Started(DateTimeOffset at, long pending, DateTimeOffset? lastAcknowledgedAt)
    {
        lock (gate) Append(new DeliveryEvent(at, "start", null, pending, lastAcknowledgedAt, null));
    }

    /// "acknowledged" and "up-to-date" are the same news; "sending", "idle",
    /// "disabled" and "not-enrolled" are not outcomes of an attempt.
    private static string? Outcome(string state) => state switch
    {
        "acknowledged" or "up-to-date" => "ok",
        "start" => "start",
        _ when DeliveryNotificationTracker.IsFailure(state) => state,
        _ => null,
    };

    private void Append(DeliveryEvent value)
    {
        last = value;
        try
        {
            Directory.CreateDirectory(dataDirectory);
            var events = Read(dataDirectory).Append(value).TakeLast(Kept).ToArray();
            var target = Path.Combine(dataDirectory, FileName);
            var aside = target + ".tmp";
            File.WriteAllText(aside, JsonSerializer.Serialize(events));
            File.Move(aside, target, overwrite: true);
        }
        // Being unable to keep the history must never be what stops delivery.
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// The events on record, oldest first, or none.
    public static IReadOnlyList<DeliveryEvent> Read(string dataDirectory)
    {
        try
        {
            return JsonSerializer.Deserialize<DeliveryEvent[]>(
                File.ReadAllText(Path.Combine(dataDirectory, FileName))) ?? [];
        }
        catch (IOException) { return []; }
        catch (UnauthorizedAccessException) { return []; }
        catch (JsonException) { return []; }
    }
}
