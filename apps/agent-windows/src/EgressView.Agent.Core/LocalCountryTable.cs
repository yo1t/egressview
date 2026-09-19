namespace EgressView.Agent.Core;

public enum LocalCountryTableState { Absent, Ready, Expired, Unreadable }

public sealed record LocalCountryTableStatus(
    LocalCountryTableState State, DateTimeOffset? BuiltAt, string? DatabaseType, string? Failure)
{
    public bool IsUsable => State == LocalCountryTableState.Ready;
}

/// The country table kept on this PC, and what the Agent is obliged to say
/// about it.
///
/// Opening it is deferred and the result remembered: most machines have no
/// file at all, and the ones that do should pay for parsing the metadata once
/// rather than on every address.
///
/// The existing routes stay. This is another source, tried only for addresses
/// the Hub did not place, so a machine with a Hub keeps the richer answer --
/// coordinates and a city -- and a machine without one stops having nothing.
public sealed class LocalCountryTable(string path)
{
    /// MaxMind's licence requires moving to a new build promptly and
    /// destroying anything more than thirty days behind it. A copy this old is
    /// therefore not merely stale: continuing to use it breaks the terms the
    /// file came under, so it is refused rather than quietly relied on.
    public static readonly TimeSpan MaximumAge = TimeSpan.FromDays(30);

    /// Required by the licence wherever the data is used.
    public const string Attribution =
        "This product includes GeoLite Data created by MaxMind, available from https://www.maxmind.com";

    private readonly object gate = new();
    private MaxMindDatabase? database;
    private string? failure;
    private DateTimeOffset loadedWriteTime;
    private bool loaded;

    public string Path { get; } = path;

    public LocalCountryTableStatus Status(DateTimeOffset now)
    {
        lock (gate)
        {
            Load();
            if (failure is not null) return new(LocalCountryTableState.Unreadable, null, null, failure);
            if (database is null) return new(LocalCountryTableState.Absent, null, null, null);
            var metadata = database.Metadata;
            var state = metadata.Age(now) > MaximumAge ? LocalCountryTableState.Expired : LocalCountryTableState.Ready;
            return new(state, metadata.BuiltAt, metadata.DatabaseType, null);
        }
    }

    /// <returns>The country, or null when there is no usable table or no entry.</returns>
    public string? CountryCode(string address, DateTimeOffset now)
    {
        lock (gate)
        {
            Load();
            if (database is null) return null;
            if (database.Metadata.Age(now) > MaximumAge) return null;
            try { return database.CountryCode(address); }
            catch (MaxMindException) { return null; }
        }
    }

    /// Called after the file is replaced, so the next question reads the new
    /// table rather than the one held open from before.
    public void Reload()
    {
        lock (gate) { loaded = false; database = null; failure = null; }
    }

    private void Load()
    {
        // Reloaded when the file on disk has moved on, so an update taking
        // effect does not depend on someone remembering to say so.
        var writeTime = File.Exists(Path) ? new DateTimeOffset(File.GetLastWriteTimeUtc(Path), TimeSpan.Zero) : default;
        if (loaded && writeTime == loadedWriteTime) return;
        loaded = true;
        loadedWriteTime = writeTime;
        database = null;
        failure = null;
        if (writeTime == default) return;
        try { database = MaxMindDatabase.Open(Path); }
        catch (MaxMindException exception) { failure = exception.Kind.ToString(); }
        catch (Exception exception) { failure = exception.GetType().Name; }
    }
}
