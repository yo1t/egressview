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
    private readonly DispatcherTimer timer;
    private double longitude = 140;
    private DateTimeOffset previousFrame;
    private bool rotating = true;

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

        // Deliberately coarse, bundled land silhouettes: recognizable context without map-tile traffic.
        var landPen = new Pen(accent, 1.1);
        foreach (var land in Land)
            DrawLine(drawing, landPen, land, center, radius);
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

    private static readonly (double Lat, double Lon)[][] Land =
    [
        [(72,-165),(60,-140),(50,-125),(25,-105),(10,-80),(30,-65),(48,-55),(70,-85),(72,-165)],
        [(12,-80),(-5,-75),(-25,-70),(-55,-68),(-35,-50),(-5,-35),(12,-55),(12,-80)],
        [(72,-10),(55,20),(60,60),(45,100),(55,150),(35,145),(10,105),(5,75),(25,50),(35,15),(55,-10),(72,-10)],
        [(35,-15),(15,-18),(-35,18),(-35,35),(-5,50),(20,40),(35,15),(35,-15)],
        [(-10,112),(-40,115),(-43,145),(-15,154),(-10,112)],
        [(45,130),(31,130),(35,140),(44,146),(45,130)]
    ];
}
