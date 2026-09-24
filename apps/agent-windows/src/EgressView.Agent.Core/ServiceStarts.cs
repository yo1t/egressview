using System.Text.Json;

namespace EgressView.Agent.Core;

/// One start of the service, written before it touches the database.
///
/// run_history lives in the database, so a start that dies while opening it --
/// the integrity check on a multi-gigabyte file, a migration, the first
/// seconds after an upgrade -- leaves no row. On 2026-09-18 an upgraded
/// service ran for ten seconds and died; Windows logged it (SCM 7031) and the
/// Agent's own history went straight from the old version's clean stop to the
/// restart a minute later, as if nothing had happened in between. The
/// mechanism built so that a crash could be seen was blind to the moment the
/// service is most likely to crash. P3-133.
///
/// So the start is written somewhere that needs no database, and the next
/// start that does reach the database files every one it finds there.
public sealed record ServiceStart(string Token, DateTimeOffset At, string Version);

public static class ServiceStarts
{
    public const string FileName = "service-starts.json";

    /// The fault recorded for a start that never reached run_history. Not an
    /// exception type -- nobody knows what stopped it, and that is the point
    /// -- but in the same shape, so the column keeps one kind of value.
    public const string StoppedBeforeRecording = "StoppedBeforeRecording";

    /// Bounded, so a service that dies on every start for a week does not grow
    /// a file without end. More than run_history keeps, so nothing is lost
    /// between the two.
    public const int Kept = 60;

    /// Writes this start down, before anything else can fail.
    ///
    /// The token, not the process ID, identifies it: a PID is reused, and a
    /// later start that happened to get the same one must not mistake an
    /// earlier death for itself.
    ///
    /// Failures are swallowed. Being unable to write this file must not be
    /// what stops a service from starting; it only means this start, if it
    /// dies early, is as invisible as every start was before.
    public static ServiceStart Record(string dataDirectory, string version, DateTimeOffset at)
    {
        var start = new ServiceStart(Guid.NewGuid().ToString("N"), at, version);
        try
        {
            Directory.CreateDirectory(dataDirectory);
            Write(dataDirectory, Read(dataDirectory).Append(start).TakeLast(Kept).ToArray());
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
        return start;
    }

    /// The starts on record, oldest first, or none.
    public static IReadOnlyList<ServiceStart> Read(string dataDirectory)
    {
        try
        {
            return JsonSerializer.Deserialize<ServiceStart[]>(
                File.ReadAllText(Path.Combine(dataDirectory, FileName))) ?? [];
        }
        catch (IOException) { return []; }
        catch (UnauthorizedAccessException) { return []; }
        catch (JsonException) { return []; }
    }

    /// Forgets them, once the database holds them.
    ///
    /// Emptied rather than deleted, so a reader cannot tell "never written"
    /// from "written and then lost" by the file being absent.
    public static void Clear(string dataDirectory)
    {
        try { Write(dataDirectory, []); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    private static void Write(string dataDirectory, ServiceStart[] starts)
    {
        var target = Path.Combine(dataDirectory, FileName);
        var aside = target + ".tmp";
        File.WriteAllText(aside, JsonSerializer.Serialize(starts));
        File.Move(aside, target, overwrite: true);
    }
}
