namespace EgressView.Agent.Core;

public static class GlobePresentation
{
    /// <summary>Advances the projection centre in the same eastward direction as the Mac Agent.</summary>
    public static double AdvanceLongitude(double current, TimeSpan elapsed, double degreesPerSecond)
    {
        var next = current - Math.Max(0, elapsed.TotalSeconds) * Math.Clamp(degreesPerSecond, 0.5, 30);
        return (next % 360 + 360) % 360;
    }

    public static string CountryFlag(string? code)
    {
        var normalized = code?.Trim().ToUpperInvariant() ?? string.Empty;
        if (normalized.Length != 2 || normalized.Any(letter => letter is < 'A' or > 'Z')) return string.Empty;
        return string.Concat(normalized.Select(letter => char.ConvertFromUtf32(0x1F1E6 + letter - 'A')));
    }
}
