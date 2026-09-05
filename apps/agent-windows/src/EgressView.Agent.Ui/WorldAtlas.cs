using System.Text.Json;
using System.Windows;

namespace EgressView.Agent.Ui;

internal static class WorldAtlas
{
    internal static IReadOnlyList<(double Lat, double Lon)[]> Load()
    {
        try
        {
            var info = System.Windows.Application.GetResourceStream(
                new Uri("Resources/world-atlas-countries-110m.json", UriKind.Relative));
            if (info is null) return [];
            using var document = JsonDocument.Parse(info.Stream);
            var root = document.RootElement;
            var transform = root.GetProperty("transform");
            var scale = transform.GetProperty("scale").EnumerateArray().Select(value => value.GetDouble()).ToArray();
            var translate = transform.GetProperty("translate").EnumerateArray().Select(value => value.GetDouble()).ToArray();
            var arcs = new List<(double Lat, double Lon)[]>();
            foreach (var rawArc in root.GetProperty("arcs").EnumerateArray())
            {
                var x = 0d; var y = 0d; var points = new List<(double, double)>();
                foreach (var rawPoint in rawArc.EnumerateArray())
                {
                    var values = rawPoint.EnumerateArray().Select(value => value.GetDouble()).ToArray();
                    x += values[0]; y += values[1];
                    points.Add((y * scale[1] + translate[1], x * scale[0] + translate[0]));
                }
                arcs.Add(points.ToArray());
            }

            var result = new List<(double Lat, double Lon)[]>();
            var geometries = root.GetProperty("objects").GetProperty("countries").GetProperty("geometries");
            foreach (var geometry in geometries.EnumerateArray())
            {
                var type = geometry.GetProperty("type").GetString();
                if (type == "Polygon") AddPolygon(geometry.GetProperty("arcs"), arcs, result);
                else if (type == "MultiPolygon")
                    foreach (var polygon in geometry.GetProperty("arcs").EnumerateArray()) AddPolygon(polygon, arcs, result);
            }
            return result;
        }
        catch { return []; }
    }

    private static void AddPolygon(JsonElement polygon, IReadOnlyList<(double Lat, double Lon)[]> arcs,
        ICollection<(double Lat, double Lon)[]> result)
    {
        foreach (var ringElement in polygon.EnumerateArray())
        {
            var ring = new List<(double Lat, double Lon)>();
            foreach (var indexElement in ringElement.EnumerateArray())
            {
                var encoded = indexElement.GetInt32();
                var index = encoded >= 0 ? encoded : ~encoded;
                if (index < 0 || index >= arcs.Count) continue;
                var segment = encoded >= 0 ? arcs[index] : arcs[index].Reverse().ToArray();
                ring.AddRange(ring.Count == 0 ? segment : segment.Skip(1));
            }
            if (ring.Count >= 3) result.Add(ring.ToArray());
        }
    }
}
