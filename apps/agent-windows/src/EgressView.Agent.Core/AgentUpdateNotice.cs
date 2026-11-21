namespace EgressView.Agent.Core;

/// Whether the window should say that a newer version is out.
///
/// Until 2026-11-21 the daily check said so only in Settings > Software
/// updates, which a person who is not looking for an update never opens, so a
/// newer version could sit unnoticed. The window now says it across the top.
public static class AgentUpdateNotice
{
    /// The version to announce, or null.
    ///
    /// Only a version newer than the one running: one the person has already
    /// installed, or an older one a stale record still names, says nothing.
    /// And not one they closed the notice for, until a newer one comes.
    public static string? VersionToAnnounce(string? available, string current, string? dismissed)
    {
        if (!IsNewer(available, current)) return null;
        return string.Equals(available, dismissed, StringComparison.Ordinal) ? null : available;
    }

    public static bool IsNewer(string? candidate, string current) =>
        Version.TryParse(candidate, out var offered) && Version.TryParse(current, out var running) && offered > running;
}
