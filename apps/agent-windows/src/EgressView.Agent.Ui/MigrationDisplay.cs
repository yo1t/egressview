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
    private static MigrationProgress? Current() =>
        MigrationProgress.Read(MigrationProgress.ServiceDatabaseFrom(AppContext.BaseDirectory));

    /// Whether the migration stopped rather than finished.
    public static bool Failed() => Current()?.Phase == MigrationProgress.Failed;

    /// The sentence, or null when nothing is being migrated.
    ///
    /// Read only when the pipe has failed. While the Agent answers, what the
    /// Agent says is better than a file beside its database.
    public static string? Text()
    {
        var progress = Current();
        if (progress is null) return null;
        return progress.Phase switch
        {
            MigrationProgress.BackingUp => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationBackingUp"), progress.ToVersion),
            MigrationProgress.MovingRows => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationMovingRows"), progress.ToVersion, progress.Rows),
            MigrationProgress.Failed => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationFailed"), progress.ToVersion),
            _ => string.Format(CultureInfo.CurrentCulture,
                LocalizationManager.Text("MigrationInProgress"), progress.ToVersion),
        };
    }

    /// The migration sentence if there is one, and the caller's own message
    /// if there is not.
    ///
    /// The pipe not answering has two meanings and the window used to show
    /// one of them. A service that is broken and a service that is two
    /// minutes into a schema migration look identical from outside, and only
    /// one of them is worth doing something about.
    public static string Or(string fallback) => Text() ?? fallback;
}
