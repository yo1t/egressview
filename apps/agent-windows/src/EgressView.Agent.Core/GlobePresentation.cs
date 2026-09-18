namespace EgressView.Agent.Core;

public static class GlobePresentation
{
    /// <summary>Advances the projection centre in the same eastward direction as the Mac Agent.</summary>
    public static double AdvanceLongitude(double current, TimeSpan elapsed, double degreesPerSecond)
    {
        var next = current - Math.Max(0, elapsed.TotalSeconds) * Math.Clamp(degreesPerSecond, 0.5, 30);
        return (next % 360 + 360) % 360;
    }
}
