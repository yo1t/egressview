using System.Globalization;

namespace EgressView.Agent.Core;

/// Where this PC sits, so traffic can be drawn as leaving from somewhere.
///
/// The Hub lets the operator pick a home country, and so does this PC's
/// Settings > General (P3-178). Left to follow Windows, it reads the country
/// the machine is configured for. That is a statement about the country,
/// never about the address: no lookup is made and nothing is sent.
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

    /// Where the globe draws from: the country chosen in settings, else the
    /// one Windows is set to, else nowhere (P3-178).
    ///
    /// Nowhere, not Tokyo. Every country outside the table, and every PC
    /// Windows could say nothing about, used to be drawn from Japan without
    /// a word -- a Thai or Polish reader's traffic leaving from a city it
    /// never touched. Null tells the globe to draw no lines and say why.
    ///
    /// A capital from the table where there is one, so the Hub, the Mac and
    /// this agree; otherwise the middle of the country on the map
    /// (<paramref name="center"/>). Nothing is looked up and nothing is sent.
    public static (double Latitude, double Longitude)? Resolve(string? chosen, string? region,
        Func<string, (double Latitude, double Longitude)?> center)
    {
        foreach (var candidate in new[] { chosen, region })
        {
            if (string.IsNullOrWhiteSpace(candidate)) continue;
            var code = candidate.Trim().ToUpperInvariant();
            return Coordinates.TryGetValue(code, out var capital) ? capital : center(code);
        }
        return null;
    }

    /// The country Windows is set to: Settings > Time & language > Region >
    /// "Country or region", as two letters, or null.
    ///
    /// Not CultureInfo.CurrentCulture, which is the display format. Before
    /// P3-178 that was what was read, so choosing Japanese date formats made
    /// a PC in Germany Japanese.
    public static string? WindowsRegion()
    {
        try
        {
            var buffer = new char[16];
            var length = GetUserDefaultGeoName(buffer, buffer.Length);
            if (length > 1 && TwoLetters(new string(buffer, 0, length - 1)) is { } name) return name;
        }
        catch (EntryPointNotFoundException) { } // before Windows 10 1709
        catch (Exception) { return null; }
        try
        {
            var nation = GetUserGeoID(GeoClassNation);
            if (nation == GeoIdNotAvailable) return null;
            var buffer = new char[16];
            var length = GetGeoInfo(nation, GeoIso2, buffer, buffer.Length, 0);
            return length > 1 ? TwoLetters(new string(buffer, 0, length - 1)) : null;
        }
        catch (Exception) { return null; }
    }

    /// A region Windows gives as two letters; its world regions are numbers
    /// ("419", Latin America), which name no country.
    internal static string? TwoLetters(string value) =>
        value.Length == 2 && char.IsAsciiLetter(value[0]) && char.IsAsciiLetter(value[1]) ? value.ToUpperInvariant() : null;

    /// Whether the table has a capital for this country.
    public static bool HasCapital(string code) => Coordinates.ContainsKey(code.ToUpperInvariant());

    private const int GeoClassNation = 16;
    private const int GeoIso2 = 4;
    private const int GeoIdNotAvailable = -1;

    [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int GetUserDefaultGeoName(char[] geoName, int geoNameCount);

    [System.Runtime.InteropServices.DllImport("kernel32.dll")]
    private static extern int GetUserGeoID(int geoClass);

    [System.Runtime.InteropServices.DllImport("kernel32.dll", EntryPoint = "GetGeoInfoW", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    private static extern int GetGeoInfo(int location, int geoType, char[] geoData, int geoDataCount, int languageId);

    /// The middle of a country's largest outline, the same rule the Mac uses.
    ///
    /// The largest, because islands and exclaves would pull the point into
    /// the sea. The area-weighted centre of that ring, not the middle of its
    /// bounding box, which for a crescent can fall outside the country.
    /// Longitudes are unwrapped around the ring's first point, so a ring that
    /// crosses the date line -- Fiji's -- is not averaged across the globe.
    public static (double Latitude, double Longitude)? Center(IEnumerable<IReadOnlyList<(double Lat, double Lon)>> rings)
    {
        (double Area, double Latitude, double Longitude)? best = null;
        foreach (var ring in rings)
        {
            if (ring.Count < 3) continue;
            var firstLongitude = ring[0].Lon;
            var xs = new double[ring.Count];
            for (var i = 0; i < ring.Count; i++)
            {
                var x = ring[i].Lon;
                while (x - firstLongitude > 180) x -= 360;
                while (x - firstLongitude < -180) x += 360;
                xs[i] = x;
            }
            double twiceArea = 0, cx = 0, cy = 0;
            for (var i = 0; i < ring.Count; i++)
            {
                var j = (i + 1) % ring.Count;
                var cross = xs[i] * ring[j].Lat - xs[j] * ring[i].Lat;
                twiceArea += cross;
                cx += (xs[i] + xs[j]) * cross;
                cy += (ring[i].Lat + ring[j].Lat) * cross;
            }
            var area = Math.Abs(twiceArea) / 2;
            if (area <= 0 || best is { } current && area <= current.Area) continue;
            var longitude = cx / (3 * twiceArea);
            while (longitude > 180) longitude -= 360;
            while (longitude < -180) longitude += 360;
            best = (area, cy / (3 * twiceArea), longitude);
        }
        return best is { } found ? (found.Latitude, found.Longitude) : null;
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
