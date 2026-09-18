using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using System.Windows.Threading;
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
    private readonly Dictionary<string, DateTimeOffset> recent = new(StringComparer.OrdinalIgnoreCase);
    private readonly DispatcherTimer glowTimer;

    public WorldCountryMapControl()
    {
        glowTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1d / 15) };
        glowTimer.Tick += (_, _) => { InvalidateVisual(); ReconcileGlowTimer(); };
        IsVisibleChanged += (_, _) => ReconcileGlowTimer();
        Unloaded += (_, _) => glowTimer.Stop();
    }

    // The render check selects a precise moment, including the final fade.
    internal DateTimeOffset? RenderMoment { get; set; }

    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

    public int MappedCountryCount => atlas.Count(country => country.Code is not null && visited.Contains(country.Code));

    public void SetVisitedCountries(IEnumerable<string> countryCodes)
    {
        visited = countryCodes.Where(code => !string.IsNullOrWhiteSpace(code))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
        InvalidateVisual();
    }

    public void MarkActivity(string countryCode, DateTimeOffset observedAt)
    {
        if (!visited.Contains(countryCode)) return;
        if (!recent.TryGetValue(countryCode, out var previous) || observedAt > previous)
            recent[countryCode] = observedAt;
        InvalidateVisual();
        ReconcileGlowTimer();
    }

    private void ReconcileGlowTimer()
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var code in recent.Where(item => CountryGlow.Intensity(item.Value, now) == 0)
            .Select(item => item.Key).ToArray()) recent.Remove(code);
        if (IsVisible && recent.Count > 0) glowTimer.Start(); else glowTimer.Stop();
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
        land.Freeze();
        var selected = ((Brush)FindResource("AccentBrush")).Frozen();
        var selectedFill = selected.Clone();
        selectedFill.Opacity = 0.72;
        selectedFill.Freeze();
        drawing.DrawGeometry(land, new Pen(border.Frozen(), 0.4).Frozen(), unvisited);
        drawing.DrawGeometry(selectedFill, new Pen(selected, 0.7).Frozen(), reached);

        // Reproject only the few countries that are currently glowing. The
        // normal all-time map is a still picture with no frame timer at all.
        var now = RenderMoment ?? DateTimeOffset.UtcNow;
        foreach (var country in atlas.Where(country => country.Code is not null &&
            recent.TryGetValue(country.Code, out var seen) && CountryGlow.Intensity(seen, now) > 0.01))
        {
            var intensity = CountryGlow.Intensity(recent[country.Code!], now);
            var shape = new StreamGeometry { FillRule = FillRule.EvenOdd };
            using (var path = shape.Open())
                foreach (var ring in country.Rings)
                    foreach (var piece in EqualEarthProjection.Split(ring))
                    {
                        if (piece.Count < 3) continue;
                        path.BeginFigure(Project(piece[0].Lat, piece[0].Lon), true, true);
                        foreach (var coordinate in piece.Skip(1))
                            path.LineTo(Project(coordinate.Lat, coordinate.Lon), true, false);
                    }
            shape.Freeze();
            var halo = System.Windows.Media.Brushes.Cyan.Clone();
            halo.Opacity = 0.55 * intensity;
            halo.Freeze();
            var glowFill = System.Windows.Media.Brushes.Cyan.Clone();
            glowFill.Opacity = 0.85 * intensity;
            glowFill.Freeze();
            drawing.DrawGeometry(null, new Pen(halo, 1 + 7 * intensity).Frozen(), shape);
            drawing.DrawGeometry(glowFill, null, shape);
        }
    }
}
