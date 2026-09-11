using System.Text.Json;
using System.Globalization;

namespace EgressView.Agent.Ui;

internal static class WorldAtlas
{
    internal sealed record Country(string? Code, string Name, IReadOnlyList<(double Lat, double Lon)[]> Rings);

    internal static IReadOnlyList<Country> Load()
    {
        try
        {
            var info = System.Windows.Application.GetResourceStream(
                new Uri("pack://application:,,,/EgressView.Agent.Ui;component/Resources/world-atlas-countries-110m.json", UriKind.Absolute));
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

            var result = new List<Country>();
            var geometries = root.GetProperty("objects").GetProperty("countries").GetProperty("geometries");
            var codesByEnglishName = CountryCodesByEnglishName();
            var aliases = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["W. Sahara"] = "EH", ["United States of America"] = "US",
                ["Dem. Rep. Congo"] = "CD", ["Dominican Rep."] = "DO",
                ["Falkland Is."] = "FK", ["Fr. S. Antarctic Lands"] = "TF",
                ["Côte d'Ivoire"] = "CI", ["Central African Rep."] = "CF",
                ["Congo"] = "CG", ["Eq. Guinea"] = "GQ", ["eSwatini"] = "SZ",
                ["Palestine"] = "PS", ["Myanmar"] = "MM", ["Turkey"] = "TR",
                ["Solomon Is."] = "SB", ["China"] = "CN", ["Bosnia and Herz."] = "BA",
                ["Macedonia"] = "MK", ["Trinidad and Tobago"] = "TT", ["S. Sudan"] = "SS",
            };
            foreach (var geometry in geometries.EnumerateArray())
            {
                var name = geometry.TryGetProperty("properties", out var properties) &&
                    properties.TryGetProperty("name", out var nameProperty)
                    ? nameProperty.GetString() ?? string.Empty : string.Empty;
                var code = aliases.GetValueOrDefault(name) ?? codesByEnglishName.GetValueOrDefault(name);
                var rings = new List<(double Lat, double Lon)[]>();
                var type = geometry.GetProperty("type").GetString();
                if (type == "Polygon") AddPolygon(geometry.GetProperty("arcs"), arcs, rings);
                else if (type == "MultiPolygon")
                    foreach (var polygon in geometry.GetProperty("arcs").EnumerateArray()) AddPolygon(polygon, arcs, rings);
                if (rings.Count > 0) result.Add(new Country(code, name, rings));
            }
            return result;
        }
        catch { return []; }
    }

    private static Dictionary<string, string> CountryCodesByEnglishName()
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var culture in CultureInfo.GetCultures(CultureTypes.SpecificCultures))
        {
            try
            {
                var region = new RegionInfo(culture.Name);
                result.TryAdd(region.EnglishName, region.TwoLetterISORegionName);
            }
            catch (ArgumentException) { }
        }
        return result;
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
