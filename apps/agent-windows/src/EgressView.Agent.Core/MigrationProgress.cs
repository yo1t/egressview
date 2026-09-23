using System.Diagnostics;
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
/// Phases and a position, not a percentage. The question a reader has is "is
/// this stuck or is it working", and "moving 31,387,127 rows" answers what the
/// work is while "43%" invites watching a number that does not move for a
/// minute at a time. The steps of one migration are nothing like each other in
/// length -- measured for v29: 42.7, 10.6, 95.8, 0.5, 134.4, 22.6 and 22.4
/// seconds -- so a share of the rows would be a share of nothing. "Step 5 of
/// 8, started 4 minutes ago" is what the file can honestly say, and it was
/// what was missing on 2026-09-23, when a migration that could not finish and
/// one that was merely slow looked identical for twenty-five minutes.
public sealed record MigrationProgress(
    int FromVersion,
    int ToVersion,
    string Phase,
    long Rows,
    // When this version's migration began, kept across its steps. The clock a
    // reader wants is "how long has this been going", not "when did the last
    // step start".
    DateTimeOffset At,
    int Step = 0,
    int Steps = 0,
    // Who is writing it, and when they last said they were still there. Both
    // are needed; see StateAt.
    int ProcessId = 0,
    DateTimeOffset? Heartbeat = null)
{
    /// Copying the database aside, so a bad migration can be undone.
    public const string BackingUp = "backing-up";

    /// Rewriting the rows into their new shape.
    public const string MovingRows = "moving-rows";

    /// Putting the new tables in place of the old ones and committing.
    ///
    /// Forty-five seconds of the v29 migration on a real database, with every
    /// row already moved. Without its own name it reads as more of the moving,
    /// which is the part a reader has already been watching for minutes.
    public const string Finishing = "finishing";

    /// It stopped, and not because it finished.
    ///
    /// Without this the file simply stays where it was, and a window reading
    /// it goes on reporting the phase it never got past -- an Agent that has
    /// given up, described as one still working. Waiting is the right thing
    /// to do only while something is happening.
    ///
    /// No message. Whatever went wrong is in startup-error.txt and in the
    /// diagnostics bundle; a file the window reads is not the place to put
    /// text nobody has looked at, which in this product is how a path or a
    /// host ends up on screen.
    public const string Failed = "failed";

    /// How often a running migration says it is still running.
    ///
    /// From a timer, not between statements: one statement of the v29
    /// migration took 134 seconds on a real database, and a heartbeat that
    /// waited for it would make a working migration look dead.
    public static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(5);

    /// How long without a heartbeat before the writer is taken to be gone.
    ///
    /// Six missed beats. Long enough that a machine too busy to run a timer on
    /// time is not called dead; short enough that a stopped service is not
    /// described as updating for longer than it takes to look away and back.
    public static readonly TimeSpan StaleAfter = TimeSpan.FromSeconds(30);

    /// Where it sits for a database at a given path.
    public static string PathFor(string databasePath) => databasePath + ".migrating";

    /// Writes it where the window will look.
    ///
    /// Written aside and moved into place, so a window reading at the same
    /// moment sees the old line or the new one and never half of either. The
    /// heartbeat rewrites this file every few seconds, which turned a rare
    /// race into a frequent one.
    ///
    /// Failures are swallowed: a machine that cannot write this file is still
    /// a machine that should finish its migration. Being unable to describe
    /// the work is not a reason to abandon it. A write lost to a reader
    /// holding the file is repeated by the next heartbeat.
    public static void Write(string databasePath, MigrationProgress progress)
    {
        var target = PathFor(databasePath);
        var aside = target + ".tmp";
        try
        {
            File.WriteAllText(aside, string.Join('\t',
                progress.FromVersion.ToString(CultureInfo.InvariantCulture),
                progress.ToVersion.ToString(CultureInfo.InvariantCulture),
                progress.Phase,
                progress.Rows.ToString(CultureInfo.InvariantCulture),
                progress.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture),
                progress.Step.ToString(CultureInfo.InvariantCulture),
                progress.Steps.ToString(CultureInfo.InvariantCulture),
                progress.ProcessId.ToString(CultureInfo.InvariantCulture),
                progress.Heartbeat?.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) ?? string.Empty));
            File.Move(aside, target, overwrite: true);
        }
        catch (IOException) { }
        catch (UnauthorizedAccessException) { }
    }

    public static void Clear(string databasePath)
    {
        foreach (var file in new[] { PathFor(databasePath), PathFor(databasePath) + ".tmp" })
        {
            try { File.Delete(file); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// Reads it, or null when there is nothing to report.
    ///
    /// Whether the migration it describes is still happening is a separate
    /// question, answered by StateAt. This used to say that a file left by a
    /// process that died mid-migration was still true, because "the next
    /// start will run the same migration again". That holds only while there
    /// is a next start. On 2026-09-23 the service was stopped mid-migration,
    /// and the tray went on saying "updating" for as long as anyone cared to
    /// look -- about a migration nothing was running.
    public static MigrationProgress? Read(string databasePath)
    {
        try
        {
            var parts = File.ReadAllText(PathFor(databasePath)).Split('\t');
            // Five fields from before the position and the heartbeat were
            // written; nine since. The service and the window ship together,
            // but a file outlives the program that wrote it -- that is the
            // whole problem this file has.
            if (parts.Length != 5 && parts.Length != 9) return null;
            if (!int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var from)) return null;
            if (!int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var to)) return null;
            if (parts[2].Length == 0) return null;
            if (!long.TryParse(parts[3], NumberStyles.Integer, CultureInfo.InvariantCulture, out var rows)) return null;
            if (!DateTimeOffset.TryParse(parts[4], CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind, out var at)) return null;
            if (parts.Length == 5) return new(from, to, parts[2], rows, at);

            if (!int.TryParse(parts[5], NumberStyles.Integer, CultureInfo.InvariantCulture, out var step)) return null;
            if (!int.TryParse(parts[6], NumberStyles.Integer, CultureInfo.InvariantCulture, out var steps)) return null;
            if (!int.TryParse(parts[7], NumberStyles.Integer, CultureInfo.InvariantCulture, out var processId)) return null;
            DateTimeOffset? heartbeat = null;
            if (parts[8].Length > 0)
            {
                if (!DateTimeOffset.TryParse(parts[8], CultureInfo.InvariantCulture,
                        DateTimeStyles.RoundtripKind, out var beat)) return null;
                heartbeat = beat;
            }
            return new(from, to, parts[2], rows, at, step, steps, processId, heartbeat);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    /// Whether what this file describes is still going on.
    ///
    /// Two signals, because each fails where the other does not. The process
    /// ID answers at once when the writer is gone, but a PID is reused, and a
    /// new process that happens to get it would keep a dead migration looking
    /// alive. The heartbeat cannot be fooled by reuse, but it takes StaleAfter
    /// to notice. Either one saying "gone" is enough.
    ///
    /// Not the process start time, which would settle reuse outright: the
    /// service runs as LocalService and the window as the signed-in user, and
    /// the user is not allowed to read the start time of a service process.
    /// Measured: the existence of the process is visible, its start time is
    /// not.
    ///
    /// A hung migration still beats -- the timer is its own thread -- and
    /// that is correct: it is running, it is just not finishing. What tells a
    /// reader that apart is the position and the clock, which is P3-165.
    public MigrationState StateAt(DateTimeOffset now, Func<int, bool>? processIsRunning = null)
    {
        if (Phase == Failed) return MigrationState.Failed;
        // Written before any of this existed. Nothing here can judge it, so it
        // is taken at its word, which is what the window did before.
        if (Heartbeat is not { } beat) return MigrationState.Running;
        if (ProcessId > 0 && !(processIsRunning ?? ProcessIsRunning)(ProcessId)) return MigrationState.Interrupted;
        return now - beat > StaleAfter ? MigrationState.Interrupted : MigrationState.Running;
    }

    /// Whether a process with this ID exists.
    ///
    /// Existence only. Anything more -- a handle, its start time, whether it
    /// has exited -- needs access a signed-in user does not have to a service
    /// process, and would come back as "denied", which is not "gone".
    public static bool ProcessIsRunning(int processId)
    {
        try
        {
            using var process = Process.GetProcessById(processId);
            return true;
        }
        catch (ArgumentException) { return false; }
        catch (InvalidOperationException) { return false; }
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

/// What a migration file means now, as opposed to what it says.
public enum MigrationState
{
    /// Being written by something that is still there.
    Running,

    /// Its writer is gone. Nothing is migrating and nothing is recording, and
    /// the next start of the service will begin the migration again.
    Interrupted,

    /// The migration gave up and said so.
    Failed,
}

/// Keeps the progress file current while a migration runs.
///
/// The store says what step it is on; this repeats it every few seconds with a
/// fresh heartbeat, from a timer, so a statement that takes two minutes does
/// not look like a process that has died.
internal sealed class MigrationReporter : IDisposable
{
    private readonly string databasePath;
    private readonly TimeSpan interval;
    private readonly object gate = new();
    private MigrationProgress? current;
    private Timer? timer;
    private bool stopped;

    public MigrationReporter(string databasePath, TimeSpan? interval = null)
    {
        this.databasePath = databasePath;
        this.interval = interval ?? MigrationProgress.HeartbeatInterval;
    }

    /// The last thing reported, for a failure to carry forward.
    public MigrationProgress? Current { get { lock (gate) return current; } }

    public MigrationProgress Report(int fromVersion, int toVersion, string phase, long rows, int step, int steps)
    {
        lock (gate)
        {
            var now = DateTimeOffset.UtcNow;
            // Kept across the steps of one version, and started again for the
            // next: a chain from v25 is four migrations, and "started 20
            // minutes ago" about the fourth would be about the first.
            var startedAt = current is { } previous && previous.ToVersion == toVersion ? previous.At : now;
            current = new MigrationProgress(fromVersion, toVersion, phase, rows, startedAt,
                step, steps, Environment.ProcessId, now);
            stopped = false;
            MigrationProgress.Write(databasePath, current);
            timer ??= new Timer(_ => Beat(), null, interval, interval);
            return current;
        }
    }

    private void Beat()
    {
        lock (gate)
        {
            // Checked under the lock that Stop takes, so a beat already on its
            // way when the migration finishes cannot write the file back after
            // it has been cleared.
            if (stopped || current is null) return;
            current = current with { Heartbeat = DateTimeOffset.UtcNow };
            MigrationProgress.Write(databasePath, current);
        }
    }

    public void Stop()
    {
        lock (gate)
        {
            stopped = true;
            timer?.Dispose();
            timer = null;
        }
    }

    public void Dispose() => Stop();
}
