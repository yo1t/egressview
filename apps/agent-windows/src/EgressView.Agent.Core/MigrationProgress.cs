using System.Globalization;

namespace EgressView.Agent.Core;

/// What the Agent is doing while it cannot answer anything.
///
/// A schema migration happens inside the constructor of the store, and the IPC
/// server is built from that store, so for as long as the migration runs there
/// is nothing listening on the pipe. Measured on a real machine: the installer
/// finished in 24 seconds, the service reported Running after 5, and the Agent
/// answered nothing for 150 -- six gigabytes of backup and thirty-one million
/// rows. The window said "cannot read state", which is what it also says when
/// the service is broken.
///
/// So the progress goes somewhere that needs no service to read: a file beside
/// the database. The window looks for it exactly when the pipe fails, which is
/// the only time it could tell a reader anything they do not already know.
///
/// Phases, not a percentage. The question a reader has is "is this stuck or is
/// it working", and "moving 31,387,127 rows" answers it while "43%" invites
/// watching a number that does not move for a minute at a time. The row count
/// is the honest scale of the wait.
public sealed record MigrationProgress(int FromVersion, int ToVersion, string Phase, long Rows, DateTimeOffset At)
{
    /// Copying the database aside, so a bad migration can be undone.
    public const string BackingUp = "backing-up";

    /// Rewriting the rows into their new shape.
    public const string MovingRows = "moving-rows";

    /// Where it sits for a database at a given path.
    public static string PathFor(string databasePath) => databasePath + ".migrating";

    /// Writes it where the window will look.
    ///
    /// Failures are swallowed: a machine that cannot write this file is still
    /// a machine that should finish its migration. Being unable to describe
    /// the work is not a reason to abandon it.
    public static void Write(string databasePath, MigrationProgress progress)
    {
        try
        {
            File.WriteAllText(PathFor(databasePath), string.Join('\t',
                progress.FromVersion.ToString(CultureInfo.InvariantCulture),
                progress.ToVersion.ToString(CultureInfo.InvariantCulture),
                progress.Phase,
                progress.Rows.ToString(CultureInfo.InvariantCulture),
                progress.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)));
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public static void Clear(string databasePath)
    {
        try { File.Delete(PathFor(databasePath)); }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    /// Reads it, or null when there is nothing to report.
    ///
    /// A file left behind by a process that died mid-migration reads the same
    /// as one being written right now, and that is correct: the next start
    /// will run the same migration again, so "this is what the Agent is doing"
    /// remains true. What makes it stale is the pipe answering, and the window
    /// only looks here when it does not.
    public static MigrationProgress? Read(string databasePath)
    {
        try
        {
            var parts = File.ReadAllText(PathFor(databasePath)).Split('\t');
            if (parts.Length != 5) return null;
            if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var from)) return null;
            if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var to)) return null;
            if (!long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var rows)) return null;
            if (!DateTimeOffset.TryParse(parts[2].Length == 0 ? null : parts[4], CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind, out var at)) return null;
            return new(from, to, parts[2], rows, at);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// Where the service keeps its database, seen from another program in the
    /// same installation.
    ///
    /// The installer lays the two out side by side -- service\ and ui\ under
    /// one root -- so the window can find the file without a registry key or
    /// a privilege it does not otherwise need.
    public static string ServiceDatabaseFrom(string uiBaseDirectory) =>
        Path.GetFullPath(Path.Combine(uiBaseDirectory, "..", "service", "data", "egressview-agent.db"));
}
