namespace EgressView.Agent.Core;

/// <summary>Six-second, cosine-eased afterglow for a newly observed destination country.</summary>
public static class CountryGlow
{
    public static readonly TimeSpan Duration = TimeSpan.FromSeconds(6);

    public static double Intensity(DateTimeOffset observedAt, DateTimeOffset now)
    {
        var elapsed = (now - observedAt).TotalSeconds;
        if (elapsed < 0 || elapsed >= Duration.TotalSeconds) return 0;
        return (1 + Math.Cos(Math.PI * elapsed / Duration.TotalSeconds)) / 2;
    }
}
