namespace EgressView.Agent.Core;

public static class EnrichmentFreshness
{
    public static string Classify(DateTimeOffset? fetchedAt, TimeSpan maximumAge, DateTimeOffset now)
    {
        if (fetchedAt is null) return "not-fetched";
        return now - fetchedAt.Value <= maximumAge ? "current" : "stale";
    }
}
