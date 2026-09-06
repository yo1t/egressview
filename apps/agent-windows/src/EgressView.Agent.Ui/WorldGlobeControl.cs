using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using System.Windows.Threading;
using Point = System.Windows.Point;
using Pen = System.Windows.Media.Pen;
using Brush = System.Windows.Media.Brush;
using Brushes = System.Windows.Media.Brushes;

namespace EgressView.Agent.Ui;

/// <summary>Offline orthographic globe. It never fetches tiles or sends addresses.</summary>
public sealed class WorldGlobeControl : FrameworkElement
{
    private readonly IReadOnlyList<(double Lat, double Lon)[]> atlas = WorldAtlas.Load();
    private readonly DispatcherTimer timer;
    private double longitude = 140;
    private DateTimeOffset previousFrame;
    // Match the Mac Agent and stay still until the person explicitly asks
    // for motion. Reprojecting the complete atlas and every route at 5 fps
    // is expensive on software-rendered or remote Windows sessions.
    private bool rotating;
    private IReadOnlyList<EgressView.Agent.Core.GlobePoint> points = [];
    private readonly (double Latitude, double Longitude) home = EgressView.Agent.Core.HomeLocation.Current();

    public WorldGlobeControl()
    {
        timer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(200) };
        timer.Tick += (_, _) => Advance();
        IsVisibleChanged += (_, _) => ReconcileTimer();
        Unloaded += (_, _) => timer.Stop();
    }

    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

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

        // The globe's subject is the traffic, not the coastline: without a
        // line from here to each place, the markers say where the machine has
        // been talking but not that it was this machine doing the talking.
        var arcPen = new Pen(Brushes.Orange, 0.9) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round };
        var farSidePen = new Pen(Brushes.Orange, 0.7);
        foreach (var item in points)
        {
            var arc = EgressView.Agent.Core.GreatCircle.Path(home, (item.Latitude, item.Longitude));
            // The half of the route running behind the globe is drawn faintly
            // against the rim rather than dropped, so an arc to the far side
            // still reads as one journey instead of stopping at the edge.
            drawing.PushOpacity(0.5);
            DrawArc(drawing, arcPen, arc, center, radius, visible: true);
            drawing.Pop();
            drawing.PushOpacity(0.12);
            DrawArc(drawing, farSidePen, arc, center, radius, visible: false);
            drawing.Pop();
        }

        // Largest last, so the busiest place is drawn on top of its neighbours.
        foreach (var item in points.OrderBy(point => point.Connections))
        {
            var point = Project(item.Latitude, item.Longitude, center, radius);
            if (point is null) continue;
            var size = Math.Clamp(2.5 + Math.Log10(item.Connections + 1) * 2.2, 3, 10);
            drawing.DrawEllipse(accent, new Pen(surface, 1), point.Value, size, size);
        }

        if (Project(home.Latitude, home.Longitude, center, radius) is { } origin)
        {
            drawing.DrawEllipse(null, new Pen(Brushes.Orange, 1.4), origin, 6, 6);
            drawing.DrawEllipse(Brushes.Orange, null, origin, 2.4, 2.4);
        }
    }

    /// <param name="visible">
    /// True draws the near-side run of the arc, false the far-side run pinned
    /// to the rim. Splitting them keeps a route that crosses the horizon from
    /// being closed with a chord straight through the middle of the globe.
    /// </param>
    private void DrawArc(DrawingContext drawing, Pen pen, IReadOnlyList<(double Latitude, double Longitude)> arc,
        Point center, double radius, bool visible)
    {
        Point? prior = null;
        foreach (var step in arc)
        {
            var projected = Project(step.Latitude, step.Longitude, center, radius);
            var onThisSide = projected is not null;
            var point = projected ?? Clamp(step.Latitude, step.Longitude, center, radius);
            if (onThisSide == visible)
            {
                if (prior is not null) drawing.DrawLine(pen, prior.Value, point);
                prior = point;
            }
            else prior = null;
        }
    }

    /// The far side of the sphere projected onto the rim, which is where a
    /// point behind the globe appears from here.
    private Point Clamp(double latitude, double pointLongitude, Point center, double radius)
    {
        var centerLatitude = EgressView.Agent.Core.HomeLocation.PreferredTilt(home.Latitude);
        var phi = latitude * Math.PI / 180;
        var lambda = (pointLongitude - longitude) * Math.PI / 180;
        var phi0 = centerLatitude * Math.PI / 180;
        var x = Math.Cos(phi) * Math.Sin(lambda);
        var y = Math.Cos(phi0) * Math.Sin(phi) - Math.Sin(phi0) * Math.Cos(phi) * Math.Cos(lambda);
        var length = Math.Sqrt(x * x + y * y);
        if (length < 1e-9) return new Point(center.X + radius, center.Y);
        return new Point(center.X + x / length * radius, center.Y - y / length * radius);
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
        var centerLatitude = EgressView.Agent.Core.HomeLocation.PreferredTilt(home.Latitude);
        var phi = latitude * Math.PI / 180;
        var lambda = (pointLongitude - longitude) * Math.PI / 180;
        var phi0 = centerLatitude * Math.PI / 180;
        var visibility = Math.Sin(phi0) * Math.Sin(phi) + Math.Cos(phi0) * Math.Cos(phi) * Math.Cos(lambda);
        if (visibility < 0) return null;
        return new Point(center.X + Math.Cos(phi) * Math.Sin(lambda) * radius,
            center.Y - (Math.Cos(phi0) * Math.Sin(phi) - Math.Sin(phi0) * Math.Cos(phi) * Math.Cos(lambda)) * radius);
    }

}
