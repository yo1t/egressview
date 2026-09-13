using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using EgressView.Agent.Core;
using Point = System.Windows.Point;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;

namespace EgressView.Agent.Ui;

/// <summary>Offline Equal Earth map of countries reached in local all-time history.</summary>
public sealed class WorldCountryMapControl : FrameworkElement
{
    private readonly IReadOnlyList<WorldAtlas.Country> atlas = WorldAtlas.Load();
    private IReadOnlySet<string> visited = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

    public int MappedCountryCount => atlas.Count(country => country.Code is not null && visited.Contains(country.Code));

    public void SetVisitedCountries(IEnumerable<string> countryCodes)
    {
        visited = countryCodes.Where(code => !string.IsNullOrWhiteSpace(code))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        if (ActualWidth <= 0 || ActualHeight <= 0) return;
        var width = Math.Min(ActualWidth - 16, (ActualHeight - 16) * EqualEarthProjection.AspectRatio);
        var height = width / EqualEarthProjection.AspectRatio;
        if (width <= 0 || height <= 0) return;
        var left = (ActualWidth - width) / 2;
        var top = (ActualHeight - height) / 2;
        Point Project(double lat, double lon)
        {
            var point = EqualEarthProjection.Project(lat, lon);
            return new(left + point.X * width, top + point.Y * height);
        }

        var sea = new StreamGeometry();
        using (var context = sea.Open())
        {
            var edge = Enumerable.Range(0, 91).Select(index => Project(-90 + index * 2, -180))
                .Concat(Enumerable.Range(0, 91).Select(index => Project(90 - index * 2, 180))).ToArray();
            context.BeginFigure(edge[0], true, true);
            foreach (var point in edge.Skip(1)) context.LineTo(point, true, false);
        }
        sea.Freeze();
        var ocean = (SolidColorBrush)FindResource("AccentBrush");
        var seaFill = ocean.Clone();
        seaFill.Opacity = 0.06;
        drawing.DrawGeometry(seaFill, null, sea);

        var unvisited = new StreamGeometry { FillRule = FillRule.EvenOdd };
        var reached = new StreamGeometry { FillRule = FillRule.EvenOdd };
        using (var unvisitedPath = unvisited.Open())
        using (var reachedPath = reached.Open())
            foreach (var country in atlas)
            {
                var path = country.Code is not null && visited.Contains(country.Code) ? reachedPath : unvisitedPath;
                foreach (var ring in country.Rings)
                    foreach (var piece in EqualEarthProjection.Split(ring))
                    {
                        if (piece.Count < 3) continue;
                        path.BeginFigure(Project(piece[0].Lat, piece[0].Lon), true, true);
                        foreach (var coordinate in piece.Skip(1))
                            path.LineTo(Project(coordinate.Lat, coordinate.Lon), true, false);
                    }
            }
        unvisited.Freeze();
        reached.Freeze();
        var border = (Brush)FindResource("StrokeBrush");
        var land = border.Clone();
        land.Opacity = 0.22;
        var selected = (Brush)FindResource("AccentBrush");
        var selectedFill = selected.Clone();
        selectedFill.Opacity = 0.72;
        drawing.DrawGeometry(land, new Pen(border, 0.4), unvisited);
        drawing.DrawGeometry(selectedFill, new Pen(selected, 0.7), reached);
    }
}
