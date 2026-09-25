using System.Windows;
using Size = System.Windows.Size;
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
    private readonly IReadOnlyList<WorldAtlas.Country> atlas = WorldAtlas.Load();
    private readonly DispatcherTimer timer;
    private readonly (double Latitude, double Longitude) home = EgressView.Agent.Core.HomeLocation.Current();
    private double longitude;
    private DateTimeOffset previousFrame;
    // Match the Mac Agent and stay still until the person explicitly asks
    // for motion. Reprojecting the complete atlas and every route at 5 fps
    // is expensive on software-rendered or remote Windows sessions.
    /// A still globe hides half the destinations behind it with no sign
    /// that they are there, so it turns until someone stops it. The Mac Agent
    /// has done this since it shipped; this one opened stopped, and the half
    /// of the world facing away was simply missing.
    private bool rotating = true;
    private double degreesPerSecond = 6;
    private IReadOnlyList<EgressView.Agent.Core.GlobePoint> points = [];
    private IReadOnlySet<string> visitedCountryCodes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

    public WorldGlobeControl()
    {
        longitude = home.Longitude;
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

    public double DegreesPerSecond
    {
        get => degreesPerSecond;
        set { degreesPerSecond = Math.Clamp(value, 0.5, 30); }
    }

    public void SetPoints(IReadOnlyList<EgressView.Agent.Core.GlobePoint> value)
    {
        points = value;
        InvalidateVisual();
    }

    public void SetVisitedCountries(IEnumerable<string> countryCodes)
    {
        visitedCountryCodes = countryCodes
            .Where(code => !string.IsNullOrWhiteSpace(code))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);
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
        longitude = EgressView.Agent.Core.GlobePresentation.AdvanceLongitude(
            longitude, now - previousFrame, degreesPerSecond);
        previousFrame = now;
        InvalidateVisual();
    }

    /// A globe is round, so it asks for a square.
    ///
    /// Without this the control takes whatever width it is given and reports
    /// no height of its own, and the card is then sized by whatever else is in
    /// it. Asking for the smaller of the two dimensions keeps the card the
    /// same height whichever view is showing.
    protected override Size MeasureOverride(Size availableSize)
    {
        var width = double.IsInfinity(availableSize.Width) ? MinHeight : availableSize.Width;
        var height = double.IsInfinity(availableSize.Height) ? MinHeight : availableSize.Height;
        var side = Math.Max(MinHeight, Math.Min(width, height));
        return new Size(double.IsInfinity(availableSize.Width) ? side : availableSize.Width, side);
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var radius = Math.Max(0, Math.Min(ActualWidth, ActualHeight) / 2 - 8);
        if (radius <= 0) return;
        var center = new Point(ActualWidth / 2, ActualHeight / 2);
        var accent = ((Brush)FindResource("AccentBrush")).Frozen();
        var stroke = ((Brush)FindResource("StrokeBrush")).Frozen();
        var surface = ((Brush)FindResource("SurfaceSecondaryBrush")).Frozen();
        drawing.DrawEllipse(surface, new Pen(accent, 1.5).Frozen(), center, radius, radius);

        // One geometry per pen, not one DrawLine per segment (P3-130). Each
        // visible segment of the coastline and grid was its own drawing
        // instruction -- 4,577 in one frame of the globe render-check draws,
        // 36 now -- and while the globe rotates they are all issued again
        // every frame. The UI thread built them cheaply -- it was
        // idle nineteen samples in twenty -- but the render thread composed
        // every one: measured on 0.1.127 in a 1800x1304 window, the network
        // tab used 38% of a core with the globe rotating and 1.2% with it
        // stopped. Same lines, same breaks, a handful of instructions.
        var gridPen = new Pen(stroke, 0.8) { LineJoin = PenLineJoin.Bevel }.Frozen();
        var grid = Lines(center, radius,
            new[] { -60d, -30d, 0d, 30d, 60d }.Select(latitude =>
                Enumerable.Range(-180, 73).Select(i => (latitude, i * 5d)))
            .Concat(Enumerable.Range(0, 12).Select(i => i * 30d).Select(meridian =>
                Enumerable.Range(-18, 37).Select(i => (i * 5d, meridian)))));
        drawing.DrawGeometry(null, gridPen, grid);

        var landPen = new Pen(accent, 0.9) { LineJoin = PenLineJoin.Bevel }.Frozen();
        drawing.PushClip(new EllipseGeometry(center, radius, radius));
        drawing.PushOpacity(0.20);
        foreach (var country in atlas.Where(country => country.Code is not null && visitedCountryCodes.Contains(country.Code)))
            foreach (var ring in country.Rings)
                DrawVisitedLand(drawing, accent, ring, center, radius);
        drawing.Pop();
        drawing.Pop();
        drawing.DrawGeometry(null, landPen, Lines(center, radius, atlas.SelectMany(country => country.Rings)));

        // The globe's subject is the traffic, not the coastline: without a
        // line from here to each place, the markers say where the machine has
        // been talking but not that it was this machine doing the talking.
        var arcPen = new Pen(Brushes.Orange, 0.9) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round }.Frozen();
        var farSidePen = new Pen(Brushes.Orange, 0.7).Frozen();
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
        var markerPen = new Pen(surface, 1).Frozen();
        foreach (var item in points.OrderBy(point => point.Connections))
        {
            var point = Project(item.Latitude, item.Longitude, center, radius);
            if (point is null) continue;
            var size = Math.Clamp(2.5 + Math.Log10(item.Connections + 1) * 2.2, 3, 10);
            drawing.DrawEllipse(accent, markerPen, point.Value, size, size);
        }

        if (Project(home.Latitude, home.Longitude, center, radius) is { } origin)
        {
            drawing.DrawEllipse(null, new Pen(Brushes.Orange, 1.4).Frozen(), origin, 6, 6);
            drawing.DrawEllipse(Brushes.Orange, null, origin, 2.4, 2.4);
        }
    }

    private void DrawVisitedLand(DrawingContext drawing, Brush fill,
        IReadOnlyList<(double Lat, double Lon)> ring, Point center, double radius)
    {
        var geometry = new StreamGeometry { FillRule = FillRule.EvenOdd };
        using (var context = geometry.Open())
        {
            var segment = new List<Point>();
            foreach (var coordinate in ring)
            {
                var projected = Project(coordinate.Lat, coordinate.Lon, center, radius);
                if (projected is { } point) segment.Add(point);
                else Flush(segment, context);
            }
            Flush(segment, context);
        }
        geometry.Freeze();
        drawing.DrawGeometry(fill, null, geometry);

        static void Flush(List<Point> segment, StreamGeometryContext context)
        {
            if (segment.Count >= 3)
            {
                context.BeginFigure(segment[0], isFilled: true, isClosed: true);
                context.PolyLineTo(segment.Skip(1).ToArray(), isStroked: false, isSmoothJoin: true);
            }
            segment.Clear();
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
        // One geometry per arc and side rather than one line per step, for the
        // same reason as the coastline. Still one per arc, so overlapping
        // routes to the same region keep compounding their opacity the way
        // they did.
        var geometry = new StreamGeometry();
        using (var context = geometry.Open())
        {
            var run = new List<Point>();
            foreach (var step in arc)
            {
                var projected = Project(step.Latitude, step.Longitude, center, radius);
                var onThisSide = projected is not null;
                if (onThisSide == visible) run.Add(projected ?? Clamp(step.Latitude, step.Longitude, center, radius));
                else Flush(run, context);
            }
            Flush(run, context);
        }
        geometry.Freeze();
        drawing.DrawGeometry(null, pen, geometry);

        static void Flush(List<Point> run, StreamGeometryContext context)
        {
            if (run.Count >= 2)
            {
                context.BeginFigure(run[0], isFilled: false, isClosed: false);
                context.PolyLineTo(run.GetRange(1, run.Count - 1), isStroked: true, isSmoothJoin: false);
            }
            run.Clear();
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

    /// Every line, as one frozen geometry.
    ///
    /// Breaks exactly where the per-segment version skipped a segment: where
    /// a point is behind the globe, and where two consecutive points are more
    /// than 0.35 of the radius apart -- a line wrapping round the far side,
    /// which drawn straight would cut across the face.
    private Geometry Lines(Point center, double radius, IEnumerable<IEnumerable<(double Lat, double Lon)>> lines)
    {
        var geometry = new StreamGeometry();
        using (var context = geometry.Open())
        {
            var run = new List<Point>();
            foreach (var line in lines)
            {
                Point? prior = null;
                foreach (var coordinate in line)
                {
                    var point = Project(coordinate.Lat, coordinate.Lon, center, radius);
                    if (point is null || (prior is not null && (point.Value - prior.Value).Length >= radius * 0.35))
                        Flush(run, context);
                    if (point is not null) run.Add(point.Value);
                    prior = point;
                }
                Flush(run, context);
            }
        }
        geometry.Freeze();
        return geometry;

        static void Flush(List<Point> run, StreamGeometryContext context)
        {
            if (run.Count >= 2)
            {
                context.BeginFigure(run[0], isFilled: false, isClosed: false);
                context.PolyLineTo(run.GetRange(1, run.Count - 1), isStroked: true, isSmoothJoin: false);
            }
            run.Clear();
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
