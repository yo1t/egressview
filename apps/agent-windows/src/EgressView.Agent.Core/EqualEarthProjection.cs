namespace EgressView.Agent.Core;

/// <summary>Equal-area, flat world projection used for the all-time country atlas.</summary>
public static class EqualEarthProjection
{
    private const double A1 = 1.340264, A2 = -0.081106, A3 = 0.000893, A4 = 0.003796;
    private static readonly double HalfWidth = Unit(0, 180).X;
    private static readonly double HalfHeight = Unit(90, 0).Y;
    public static double AspectRatio => HalfWidth / HalfHeight;

    /// <summary>Normalised point, with (0,0) at the north-west of the projection.</summary>
    public static (double X, double Y) Project(double latitude, double longitude)
    {
        var unit = Unit(latitude, longitude);
        return (0.5 + unit.X / (2 * HalfWidth), 0.5 - unit.Y / (2 * HalfHeight));
    }

    private static (double X, double Y) Unit(double latitude, double longitude)
    {
        var phi = latitude * Math.PI / 180;
        var lambda = longitude * Math.PI / 180;
        var theta = Math.Asin(Math.Sqrt(3) / 2 * Math.Sin(phi));
        var t2 = theta * theta;
        var t3 = t2 * theta;
        var t6 = t3 * t3;
        var t7 = t6 * theta;
        var t8 = t6 * t2;
        var t9 = t8 * theta;
        var denominator = 3 * (9 * A4 * t8 + 7 * A3 * t6 + 3 * A2 * t2 + A1);
        return (2 * Math.Sqrt(3) * lambda * Math.Cos(theta) / denominator,
            A4 * t9 + A3 * t7 + A2 * t3 + A1 * theta);
    }

    /// <summary>Split a country ring at the 180th meridian, closing pieces along the map edge.</summary>
    public static IReadOnlyList<IReadOnlyList<(double Lat, double Lon)>> Split(
        IReadOnlyList<(double Lat, double Lon)> ring)
    {
        if (ring.Count < 2) return ring.Count == 0 ? [] : [ring];
        var pieces = new List<List<(double Lat, double Lon)>>();
        var current = new List<(double Lat, double Lon)> { ring[0] };
        foreach (var point in ring.Skip(1))
        {
            var previous = current[^1];
            var step = point.Lon - previous.Lon;
            if (Math.Abs(step) > 180)
            {
                var edge = previous.Lon > 0 ? 180d : -180d;
                var total = 360 - Math.Abs(step);
                var fraction = total > 0 ? Math.Min(1, Math.Abs(edge - previous.Lon) / total) : 0.5;
                var latitude = previous.Lat + (point.Lat - previous.Lat) * fraction;
                current.Add((latitude, edge));
                pieces.Add(current);
                current = [(latitude, -edge), point];
            }
            else current.Add(point);
        }
        pieces.Add(current);
        if (pieces.Count > 1 && Math.Abs(pieces[0][0].Lat - pieces[^1][^1].Lat) < 0.000001 &&
            Math.Abs(pieces[0][0].Lon - pieces[^1][^1].Lon) < 0.000001)
        {
            pieces[0] = [.. pieces[^1].SkipLast(1), .. pieces[0]];
            pieces.RemoveAt(pieces.Count - 1);
        }
        return pieces.Where(piece => piece.Count > 1).Select(piece => (IReadOnlyList<(double Lat, double Lon)>)piece).ToArray();
    }
}
