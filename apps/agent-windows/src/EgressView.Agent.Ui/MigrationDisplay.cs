using System.Globalization;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

/// What to show when the Agent cannot be reached because it is migrating.
///
/// These lived on MainWindow until the tray needed them too, and there the
/// name collided with Application.MainWindow -- a compiler error that was
/// also a fair question. None of this is about the main window: it is about
/// a state the whole UI has to describe, from two places that both go quiet
/// at the same time.
public static class MigrationDisplay
{
    /// The sentence and the state, from one reading of the file.
    ///
    /// One reading, because the chip and the sentence under it used to read
    /// the file separately. With a heartbeat rewriting it every five seconds
    /// and a staleness boundary between them, two readings can disagree, and
    /// a chip saying "updating" over a sentence saying "stopped" is worse than
    /// either alone.
    public sealed record Snapshot(string Text, MigrationState State);

    /// What the file beside the service's database says now, or null when
    /// nothing is being migrated.
    ///
    /// Read only when the pipe has failed. While the Agent answers, what the
    /// Agent says is better than a file beside its database.
    public static Snapshot? Describe() => Describe(
        MigrationProgress.Read(MigrationProgress.ServiceDatabaseFrom(AppContext.BaseDirectory)),
        DateTimeOffset.UtcNow);

    public static Snapshot? Describe(MigrationProgress? progress, DateTimeOffset now)
    {
        if (progress is null) return null;
        var state = progress.StateAt(now);
        var text = state switch
        {
            MigrationState.Failed => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationFailed"), progress.ToVersion),
            // Its own sentence, not the running one with a caveat. Nothing is
            // migrating and nothing is recording; the reader needs to know
            // that the service is what to look at, and that nothing is lost
            // by starting it again.
            MigrationState.Interrupted => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationInterrupted"), progress.ToVersion),
            _ => Running(progress, now),
        };
        return new Snapshot(text, state);
    }

    private static string Running(MigrationProgress progress, DateTimeOffset now)
    {
        var sentence = progress.Phase switch
        {
            MigrationProgress.BackingUp => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationBackingUp"), progress.ToVersion),
            MigrationProgress.MovingRows => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationMovingRows"), progress.ToVersion, progress.Rows),
            MigrationProgress.Finishing => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationFinishing"), progress.ToVersion, progress.Rows),
            _ => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationInProgress"), progress.ToVersion),
        };
        // Where it is and how long it has been going. On 2026-09-23 a
        // migration that could not finish and one that was merely slow read
        // the same for twenty-five minutes; "step 5 of 8, 25 minutes" beside
        // steps that had each taken a minute or two would have said which.
        if (progress.Steps <= 0) return sentence;
        var elapsed = Math.Max(0, (now - progress.At).TotalSeconds);
        return sentence + string.Format(CultureInfo.CurrentCulture,
            LocalizationManager.Text("MigrationPosition"),
            progress.Step, progress.Steps, MainWindow.FormatDuration(elapsed));
    }

    /// The sentence, or null when nothing is being migrated.
    public static string? Text() => Describe()?.Text;

    /// Whether the migration stopped rather than finished.
    public static bool Failed() => Describe()?.State == MigrationState.Failed;

    /// Whether the migration's writer is gone without saying so.
    public static bool Interrupted() => Describe()?.State == MigrationState.Interrupted;

    /// The migration sentence if there is one, and the caller's own message
    /// if there is not.
    ///
    /// The pipe not answering has two meanings and the window used to show
    /// one of them. A service that is broken and a service that is two
    /// minutes into a schema migration look identical from outside, and only
    /// one of them is worth doing something about.
    public static string Or(string fallback) => Text() ?? fallback;
}
