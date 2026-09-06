using System.Globalization;

namespace EgressView.Agent.Core;

/// Where this PC sits, so traffic can be drawn as leaving from somewhere.
///
/// The Hub lets the operator pick a home country. An agent has nobody to ask,
/// so it reads the region the machine is already configured for. That is a
/// guess about the country, never about the address: no lookup is made and
/// nothing is sent.
public static class HomeLocation
{
    /// The same capital coordinates the Web UI and the Mac Agent use, so the
    /// three maps agree about where home is.
    private static readonly Dictionary<string, (double Latitude, double Longitude)> Coordinates = new()
    {
        ["JP"] = (35.68, 139.69), ["US"] = (38.89, -77.04), ["CA"] = (45.42, -75.69),
        ["GB"] = (51.50, -0.12), ["DE"] = (52.52, 13.40), ["FR"] = (48.86, 2.35),
        ["IT"] = (41.90, 12.50), ["ES"] = (40.42, -3.70), ["NL"] = (52.09, 5.10),
        ["SE"] = (59.33, 18.07), ["CH"] = (46.95, 7.45), ["NO"] = (59.91, 10.75),
        ["AU"] = (-35.28, 149.13), ["NZ"] = (-41.29, 174.78), ["CN"] = (39.91, 116.39),
        ["KR"] = (37.57, 126.98), ["TW"] = (25.04, 121.56), ["HK"] = (22.32, 114.17),
        ["SG"] = (1.35, 103.82), ["IN"] = (28.61, 77.21), ["BR"] = (-15.79, -47.88),
        ["RU"] = (55.75, 37.62),
    };

    public static (double Latitude, double Longitude) Current(string? region = null)
    {
        region ??= SafeRegion();
        return region is not null && Coordinates.TryGetValue(region.ToUpperInvariant(), out var match)
            ? match
            : Coordinates["JP"];
    }

    /// How far to tip the globe, and which way.
    ///
    /// Towards the hemisphere the traffic leaves from. Every arc starts at
    /// this PC, so the one place that must never be squashed against the rim
    /// is home -- tipping the other way hides exactly the point the picture is
    /// drawn around. The magnitude is small on purpose: enough to open up the
    /// home hemisphere, not so much that the equator stops reading as level.
    public static double PreferredTilt(double latitude, double magnitude = 12) =>
        latitude >= 0 ? magnitude : -magnitude;

    private static string? SafeRegion()
    {
        try { return new RegionInfo(CultureInfo.CurrentCulture.Name).TwoLetterISORegionName; }
        catch (Exception) { return null; }
    }
}

/// Points along the great circle between two places.
///
/// A straight line on a projected globe is not the path between two points on
/// a sphere, and drawing one would put the route through countries it does not
/// pass over.
public static class GreatCircle
{
    public static (double Latitude, double Longitude)[] Path(
        (double Latitude, double Longitude) origin,
        (double Latitude, double Longitude) destination,
        int segments = 48)
    {
        var steps = Math.Max(1, segments);
        var phi1 = origin.Latitude * Math.PI / 180;
        var lambda1 = origin.Longitude * Math.PI / 180;
        var phi2 = destination.Latitude * Math.PI / 180;
        var lambda2 = destination.Longitude * Math.PI / 180;

        var delta = 2 * Math.Asin(Math.Min(1, Math.Sqrt(
            Math.Pow(Math.Sin((phi2 - phi1) / 2), 2)
            + Math.Cos(phi1) * Math.Cos(phi2) * Math.Pow(Math.Sin((lambda2 - lambda1) / 2), 2))));
        // The same point, or near enough that interpolation would divide by
        // roughly zero.
        if (delta <= 1e-9) return [origin, destination];

        var path = new (double Latitude, double Longitude)[steps + 1];
        for (var step = 0; step <= steps; step++)
        {
            var fraction = (double)step / steps;
            var a = Math.Sin((1 - fraction) * delta) / Math.Sin(delta);
            var b = Math.Sin(fraction * delta) / Math.Sin(delta);
            var x = a * Math.Cos(phi1) * Math.Cos(lambda1) + b * Math.Cos(phi2) * Math.Cos(lambda2);
            var y = a * Math.Cos(phi1) * Math.Sin(lambda1) + b * Math.Cos(phi2) * Math.Sin(lambda2);
            var z = a * Math.Sin(phi1) + b * Math.Sin(phi2);
            path[step] = (Math.Atan2(z, Math.Sqrt(x * x + y * y)) * 180 / Math.PI, Math.Atan2(y, x) * 180 / Math.PI);
        }
        return path;
    }
}
