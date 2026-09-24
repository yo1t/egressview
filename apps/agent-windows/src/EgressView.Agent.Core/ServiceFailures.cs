using System.Text.Json;
using System.Text.Json.Serialization;

namespace EgressView.Agent.Core;

/// Why the service stopped with an error, kept where a diagnostics bundle can
/// carry it.
///
/// The service already wrote startup-error.txt when it failed: the time, the
/// exception's type and its message. Nothing read it. The window says "the
/// update failed" and points at the diagnostics export, and the export said
/// nothing about the failure -- when the service was down, the window's
/// limited report recorded the window's own connection timeout instead. The
/// reason survived on disk and reached nobody. P3-161.
///
/// This is the part of that failure a bundle may carry. The message is left
/// out on purpose: an IOException names a path, a SQLite error can quote the
/// database, and this product's bundles promise no endpoint, host, process
/// name or path. What is kept -- the type, the store's own classification,
/// and which migration step it stopped at -- is chosen from values the Agent
/// defines, so it cannot contain anything it read from the machine.
/// startup-error.txt stays as it was, with the message, for someone at the
/// machine.
public sealed record ServiceFailure(
    DateTimeOffset At,
    string ExceptionType,
    string? StoreFailure,
    ServiceFailure.MigrationStep? Migration)
{
    /// Where it stopped, when it stopped inside a migration.
    public sealed record MigrationStep(int FromVersion, int ToVersion, int Step, int Steps);

    public const string FileName = "service-failures.json";

    /// How many are kept, newest last. One would answer "why did it fail";
    /// a few answer "has it failed the same way every time", which is the
    /// question after a migration that fails at step 6 on each start.
    public const int Kept = 5;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        WriteIndented = true,
    };

    /// What of this exception may leave the machine.
    ///
    /// The migration step is read from the progress file, which a failed
    /// migration has just rewritten as "failed" with the step it reached.
    /// That file is cleared by the next successful start, so this is the
    /// only place the step outlives it.
    public static ServiceFailure From(Exception exception, string databasePath, DateTimeOffset at)
    {
        var migration = MigrationProgress.Read(databasePath);
        return new ServiceFailure(
            at,
            exception.GetType().Name,
            (exception as ObservationStoreException)?.Kind.ToString(),
            migration is { Phase: MigrationProgress.Failed }
                ? new MigrationStep(migration.FromVersion, migration.ToVersion, migration.Step, migration.Steps)
                : null);
    }

    /// Adds one, keeping the last Kept, written aside and moved into place.
    ///
    /// Swallows its own failures: this runs on the way out of a service that
    /// has already failed, and a second failure here must not replace the
    /// first one's report in the event log.
    public static void Append(string dataDirectory, ServiceFailure failure)
    {
        try
        {
            var all = Read(dataDirectory).Append(failure).TakeLast(Kept).ToArray();
            var target = Path.Combine(dataDirectory, FileName);
            var aside = target + ".tmp";
            Directory.CreateDirectory(dataDirectory);
            File.WriteAllText(aside, JsonSerializer.Serialize(all, Json));
            File.Move(aside, target, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// The failures on record, oldest first, or none.
    ///
    /// Kept after the service starts again, deliberately: "the next start
    /// succeeded" is exactly when someone asks why the one before it did not.
    /// Each carries its time, so a reader can tell last night from last month.
    public static IReadOnlyList<ServiceFailure> Read(string dataDirectory)
    {
        try
        {
            var text = File.ReadAllText(Path.Combine(dataDirectory, FileName));
            return JsonSerializer.Deserialize<ServiceFailure[]>(text, Json) ?? [];
        }
        catch (IOException) { return []; }
        catch (UnauthorizedAccessException) { return []; }
        catch (JsonException) { return []; }
    }
}
