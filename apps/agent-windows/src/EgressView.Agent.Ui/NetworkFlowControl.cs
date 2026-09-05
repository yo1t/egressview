using System.Windows;
using System.Windows.Media;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;
using Brushes = System.Windows.Media.Brushes;

namespace EgressView.Agent.Ui;

/// <summary>Compact application-to-destination Sankey, following the Mac Agent layout.</summary>
public sealed class NetworkFlowControl : FrameworkElement
{
    private IReadOnlyList<RecentFlow> flows = [];
    public void SetItems(IReadOnlyList<RecentFlow> value) { flows = value; InvalidateVisual(); }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        if (flows.Count == 0 || ActualWidth < 220 || ActualHeight < 80) return;
        var entries = flows.GroupBy(flow => (App: flow.ProcessName ?? $"PID {flow.ProcessId}", Destination: Destination(flow)))
            .Select(group => new Entry(group.Key.App, group.Key.Destination, group.Count()))
            .OrderByDescending(entry => entry.Value).Take(12).ToArray();
        var apps = entries.GroupBy(entry => entry.App).Select(group => new Node(group.Key, group.Sum(value => value.Value)))
            .OrderByDescending(node => node.Value).Take(6).ToArray();
        var destinations = entries.Where(entry => apps.Any(app => app.Name == entry.App)).GroupBy(entry => entry.Destination)
            .Select(group => new Node(group.Key, group.Sum(value => value.Value))).OrderByDescending(node => node.Value).Take(6).ToArray();
        entries = entries.Where(entry => apps.Any(app => app.Name == entry.App) && destinations.Any(destination => destination.Name == entry.Destination)).ToArray();
        if (entries.Length == 0) return;

        const double labelWidth = 118; const double nodeWidth = 8; const double gap = 6;
        var leftX = labelWidth; var rightX = ActualWidth - labelWidth - nodeWidth;
        var usable = Math.Max(1, ActualHeight - 20);
        var appRects = Layout(apps, leftX, usable, nodeWidth, gap);
        var destinationRects = Layout(destinations, rightX, usable, nodeWidth, gap);
        var appOffsets = apps.ToDictionary(node => node.Name, _ => 0d);
        var destinationOffsets = destinations.ToDictionary(node => node.Name, _ => 0d);
        var total = Math.Max(1, entries.Sum(entry => entry.Value));
        var scale = Math.Max(1, (usable - gap * Math.Max(apps.Length - 1, destinations.Length - 1)) / total);
        var palette = Palette();

        foreach (var entry in entries)
        {
            var source = appRects[entry.App]; var target = destinationRects[entry.Destination];
            var thickness = Math.Max(1.5, entry.Value * scale);
            var sourceY = source.Top + appOffsets[entry.App] + thickness / 2;
            var targetY = target.Top + destinationOffsets[entry.Destination] + thickness / 2;
            appOffsets[entry.App] += thickness; destinationOffsets[entry.Destination] += thickness;
            var appIndex = Array.FindIndex(apps, node => node.Name == entry.App);
            var pen = new Pen(palette[appIndex % palette.Length], thickness) { StartLineCap = PenLineCap.Flat, EndLineCap = PenLineCap.Flat };
            var path = new StreamGeometry();
            using (var context = path.Open())
            {
                context.BeginFigure(new Point(leftX + nodeWidth, sourceY), false, false);
                var control = (rightX - leftX) * 0.48;
                context.BezierTo(new Point(leftX + control, sourceY), new Point(rightX - control, targetY), new Point(rightX, targetY), true, false);
            }
            drawing.PushOpacity(0.34); drawing.DrawGeometry(null, pen, path); drawing.Pop();
        }

        var secondary = (Brush)FindResource("TextSecondaryBrush");
        for (var index = 0; index < apps.Length; index++)
        {
            drawing.DrawRectangle(palette[index % palette.Length], null, appRects[apps[index].Name]);
            DrawLabel(drawing, apps[index].Name, new Point(0, appRects[apps[index].Name].Top), labelWidth - 8, TextAlignment.Left);
        }
        foreach (var node in destinations)
        {
            drawing.DrawRectangle(secondary, null, destinationRects[node.Name]);
            DrawLabel(drawing, node.Name, new Point(rightX + nodeWidth + 8, destinationRects[node.Name].Top), labelWidth - 8, TextAlignment.Right);
        }
    }

    private Dictionary<string, Rect> Layout(Node[] nodes, double x, double height, double width, double gap)
    {
        var total = Math.Max(1, nodes.Sum(node => node.Value));
        var usable = Math.Max(1, height - gap * Math.Max(0, nodes.Length - 1));
        var y = 10d; var result = new Dictionary<string, Rect>();
        foreach (var node in nodes)
        {
            var nodeHeight = Math.Max(5, usable * node.Value / total);
            result[node.Name] = new Rect(x, y, width, nodeHeight); y += nodeHeight + gap;
        }
        return result;
    }

    private void DrawLabel(DrawingContext drawing, string value, Point origin, double width, TextAlignment alignment)
    {
        var text = value.Length > 18 ? value[..8] + "…" + value[^7..] : value;
        var formatted = new FormattedText(text, System.Globalization.CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
            new Typeface("Segoe UI Variable Text"), 11, (Brush)FindResource("TextPrimaryBrush"), VisualTreeHelper.GetDpi(this).PixelsPerDip)
        { MaxTextWidth = width, TextAlignment = alignment, Trimming = TextTrimming.CharacterEllipsis };
        drawing.DrawText(formatted, origin);
    }

    private Brush[] Palette() => [
        (Brush)FindResource("AccentBrush"), Brushes.Teal, Brushes.MediumSlateBlue,
        Brushes.DarkOrange, Brushes.DeepPink, Brushes.MediumSeaGreen];
    private static string Destination(RecentFlow flow) => flow.RemoteAddress.Contains(':') ? $"[{flow.RemoteAddress}]" : flow.RemoteAddress;
    private sealed record Entry(string App, string Destination, int Value);
    private sealed record Node(string Name, int Value);
}
