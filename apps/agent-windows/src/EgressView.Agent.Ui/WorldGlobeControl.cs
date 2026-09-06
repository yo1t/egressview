using System.Windows;
using System.Windows.Media;
using System.Windows.Threading;
using Point = System.Windows.Point;
using Pen = System.Windows.Media.Pen;
using Brush = System.Windows.Media.Brush;

namespace EgressView.Agent.Ui;

/// <summary>Offline orthographic globe. It never fetches tiles or sends addresses.</summary>
public sealed class WorldGlobeControl : FrameworkElement
{
    private readonly IReadOnlyList<(double Lat, double Lon)[]> atlas = WorldAtlas.Load();
    private readonly DispatcherTimer timer;
    private double longitude = 140;
    private DateTimeOffset previousFrame;
    private bool rotating = true;
    private IReadOnlyList<EgressView.Agent.Core.GlobePoint> points = [];

    public WorldGlobeControl()
    {
        timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        timer.Tick += (_, _) => Advance();
        IsVisibleChanged += (_, _) => ReconcileTimer();
        Unloaded += (_, _) => timer.Stop();
    }

    public bool IsRotating
    {
        get => rotating;
        set { rotating = value; ReconcileTimer(); InvalidateVisual(); }
    }

    public int FramesPerSecond
    {
        set { timer.Interval = TimeSpan.FromSeconds(1d / Math.Clamp(value, 1, 30)); ReconcileTimer(); }
    }

    public void SetPoints(IReadOnlyList<EgressView.Agent.Core.GlobePoint> value)
    {
        points = value;
        InvalidateVisual();
    }

    private void ReconcileTimer()
    {
        if (IsVisible && rotating)
        {
            previousFrame = DateTimeOffset.UtcNow;
            timer.Start();
        }
        else timer.Stop();
    }

    private void Advance()
    {
        var now = DateTimeOffset.UtcNow;
        longitude = (longitude + Math.Max(0, (now - previousFrame).TotalSeconds) * 6) % 360;
        previousFrame = now;
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var radius = Math.Max(0, Math.Min(ActualWidth, ActualHeight) / 2 - 8);
        if (radius <= 0) return;
        var center = new Point(ActualWidth / 2, ActualHeight / 2);
        var accent = (Brush)FindResource("AccentBrush");
        var stroke = (Brush)FindResource("StrokeBrush");
        var surface = (Brush)FindResource("SurfaceSecondaryBrush");
        drawing.DrawEllipse(surface, new Pen(accent, 1.5), center, radius, radius);

        var gridPen = new Pen(stroke, 0.8);
        foreach (var latitude in new[] { -60d, -30d, 0d, 30d, 60d })
            DrawLine(drawing, gridPen, Enumerable.Range(-180, 73).Select(i => (latitude, i * 5d)), center, radius);
        foreach (var meridian in Enumerable.Range(0, 12).Select(i => i * 30d))
            DrawLine(drawing, gridPen, Enumerable.Range(-18, 37).Select(i => (i * 5d, meridian)), center, radius);

        var landPen = new Pen(accent, 0.9);
        foreach (var land in atlas)
            DrawLine(drawing, landPen, land, center, radius);

        foreach (var item in points.OrderBy(point => point.Connections))
        {
            var point = Project(item.Latitude, item.Longitude, center, radius);
            if (point is null) continue;
            var size = Math.Clamp(2.5 + Math.Log10(item.Connections + 1) * 2.2, 3, 10);
            drawing.DrawEllipse(accent, new Pen(surface, 1), point.Value, size, size);
        }
    }

    private void DrawLine(DrawingContext drawing, Pen pen, IEnumerable<(double Lat, double Lon)> coordinates, Point center, double radius)
    {
        Point? prior = null;
        foreach (var coordinate in coordinates)
        {
            var point = Project(coordinate.Lat, coordinate.Lon, center, radius);
            if (point is not null && prior is not null && (point.Value - prior.Value).Length < radius * 0.35)
                drawing.DrawLine(pen, prior.Value, point.Value);
            prior = point;
        }
    }

    private Point? Project(double latitude, double pointLongitude, Point center, double radius)
    {
        const double centerLatitude = 12;
        var phi = latitude * Math.PI / 180;
        var lambda = (pointLongitude - longitude) * Math.PI / 180;
        var phi0 = centerLatitude * Math.PI / 180;
        var visibility = Math.Sin(phi0) * Math.Sin(phi) + Math.Cos(phi0) * Math.Cos(phi) * Math.Cos(lambda);
        if (visibility < 0) return null;
        return new Point(center.X + Math.Cos(phi) * Math.Sin(lambda) * radius,
            center.Y - (Math.Cos(phi0) * Math.Sin(phi) - Math.Sin(phi0) * Math.Cos(phi) * Math.Cos(lambda)) * radius);
    }

}
