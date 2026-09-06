using System.Windows;
using System.Windows.Media;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;
using Brushes = System.Windows.Media.Brushes;

namespace EgressView.Agent.Ui;

/// <summary>Application-to-destination Sankey, following the Mac Agent layout.</summary>
public sealed class NetworkFlowControl : FrameworkElement
{
    /// Beyond this the ribbons are too thin to read, so the rest is summed
    /// into one visible band instead of being dropped. A chart that silently
    /// omits most of its data looks complete while showing a fraction.
    private const int TopNodes = 7;
    private const double LabelWidth = 132;
    private const double NodeWidth = 9;
    private const double NodeGap = 6;
    private const double LineHeight = 14;
    private const double TopMargin = 8;

    private IReadOnlyList<AppDestinationAggregate> links = [];
    private bool useBytes;

    public void SetItems(IReadOnlyList<AppDestinationAggregate> value, bool bytes, bool names)
    {
        links = names ? value.Select(item => item with { Destination = item.DestinationName }).ToArray() : value;
        useBytes = bytes;
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        if (links.Count == 0 || ActualWidth < 260 || ActualHeight < 90) return;

        var other = LocalizationManager.Text("FlowOther");
        var entries = links
            .Select(link => new Entry(LocalizationManager.Application(link.Application), link.Destination,
                useBytes ? link.Bytes : link.Connections))
            .Where(entry => entry.Value > 0)
            .ToArray();
        if (entries.Length == 0) return;

        // Keep every value: the ones outside the top N are folded into a band
        // rather than discarded, so the ribbons still add up to the total the
        // summary card reports.
        var appNames = TopNames(entries.GroupBy(entry => entry.App), other);
        var destinationNames = TopNames(entries.GroupBy(entry => entry.Destination), other);
        var folded = entries
            .GroupBy(entry => (App: Bucket(entry.App, appNames, other), Destination: Bucket(entry.Destination, destinationNames, other)))
            .Select(group => new Entry(group.Key.App, group.Key.Destination, group.Sum(entry => entry.Value)))
            .ToArray();

        var apps = Order(folded.GroupBy(entry => entry.App), other);
        var destinations = Order(folded.GroupBy(entry => entry.Destination), other);
        var total = folded.Sum(entry => entry.Value);
        if (total <= 0) return;

        // One scale for node heights and ribbon thickness. Two scales make the
        // ribbons leave their node, which is what a reader notices first.
        var height = Math.Max(1, ActualHeight - TopMargin * 2);
        var tallest = Math.Max(apps.Length, destinations.Length);
        var usable = Math.Max(1, height - NodeGap * Math.Max(0, tallest - 1));
        var scale = usable / (double)total;

        var leftX = LabelWidth;
        var rightX = Math.Max(leftX + 40, ActualWidth - LabelWidth - NodeWidth);
        var appRects = Layout(apps, leftX, scale);
        var destinationRects = Layout(destinations, rightX, scale);

        var appOffsets = apps.ToDictionary(node => node.Name, _ => 0d);
        var destinationOffsets = destinations.ToDictionary(node => node.Name, _ => 0d);
        var palette = Palette();
        var appIndex = apps.Select((node, index) => (node.Name, index)).ToDictionary(pair => pair.Name, pair => pair.index);

        // Largest first on both ends, so ribbons stack without crossing more
        // than they have to.
        foreach (var entry in folded.OrderByDescending(entry => entry.Value))
        {
            if (!appRects.TryGetValue(entry.App, out var source) ||
                !destinationRects.TryGetValue(entry.Destination, out var target)) continue;
            var thickness = Math.Max(1, entry.Value * scale);
            var sourceY = source.Top + appOffsets[entry.App] + thickness / 2;
            var targetY = target.Top + destinationOffsets[entry.Destination] + thickness / 2;
            appOffsets[entry.App] += thickness;
            destinationOffsets[entry.Destination] += thickness;

            var brush = entry.App == other ? MutedBrush() : palette[appIndex[entry.App] % palette.Length];
            var pen = new Pen(brush, thickness) { StartLineCap = PenLineCap.Flat, EndLineCap = PenLineCap.Flat };
            var path = new StreamGeometry();
            using (var context = path.Open())
            {
                context.BeginFigure(new Point(leftX + NodeWidth, sourceY), false, false);
                var control = (rightX - leftX) * 0.48;
                context.BezierTo(new Point(leftX + control, sourceY), new Point(rightX - control, targetY),
                    new Point(rightX, targetY), true, false);
            }
            drawing.PushOpacity(0.34);
            drawing.DrawGeometry(null, pen, path);
            drawing.Pop();
        }

        var secondary = (Brush)FindResource("TextSecondaryBrush");
        foreach (var node in apps)
        {
            var brush = node.Name == other ? MutedBrush() : palette[appIndex[node.Name] % palette.Length];
            drawing.DrawRectangle(brush, null, appRects[node.Name]);
        }
        foreach (var node in destinations) drawing.DrawRectangle(secondary, null, destinationRects[node.Name]);

        // A proportional node can be a couple of pixels tall, so its label is
        // pushed clear of the previous one rather than drawn on top of it.
        foreach (var (node, y) in Declutter(apps, appRects, height))
            DrawLabel(drawing, node.Name, FormatValue(node.Value), new Point(0, y), LabelWidth - 10, TextAlignment.Left);
        foreach (var (node, y) in Declutter(destinations, destinationRects, height))
            DrawLabel(drawing, node.Name, FormatValue(node.Value), new Point(rightX + NodeWidth + 10, y),
                Math.Max(20, ActualWidth - rightX - NodeWidth - 10), TextAlignment.Right);
    }

    private static string[] TopNames(IEnumerable<IGrouping<string, Entry>> groups, string other) =>
        groups.Select(group => new Node(group.Key, group.Sum(entry => entry.Value)))
            .OrderByDescending(node => node.Value)
            .Take(TopNodes)
            .Select(node => node.Name)
            .Where(name => name != other)
            .ToArray();

    private static string Bucket(string name, string[] top, string other) =>
        Array.IndexOf(top, name) >= 0 ? name : other;

    /// The folded band sits last however large it is: it is a remainder, not a
    /// participant, and ranking it with the named nodes would read as one.
    private static Node[] Order(IEnumerable<IGrouping<string, Entry>> groups, string other) =>
        groups.Select(group => new Node(group.Key, group.Sum(entry => entry.Value)))
            .OrderBy(node => node.Name == other)
            .ThenByDescending(node => node.Value)
            .ToArray();

    private static Dictionary<string, Rect> Layout(Node[] nodes, double x, double scale)
    {
        var y = TopMargin;
        var result = new Dictionary<string, Rect>();
        foreach (var node in nodes)
        {
            var nodeHeight = Math.Max(2, node.Value * scale);
            result[node.Name] = new Rect(x, y, NodeWidth, nodeHeight);
            y += nodeHeight + NodeGap;
        }
        return result;
    }

    private static IEnumerable<(Node Node, double Y)> Declutter(Node[] nodes, Dictionary<string, Rect> rects, double height)
    {
        var previous = double.NegativeInfinity;
        foreach (var node in nodes)
        {
            var rect = rects[node.Name];
            var y = Math.Max(rect.Top + rect.Height / 2 - LineHeight / 2, previous + LineHeight);
            if (y + LineHeight > height + TopMargin * 2) yield break;
            previous = y;
            yield return (node, y);
        }
    }

    private void DrawLabel(DrawingContext drawing, string value, string metric, Point origin, double width, TextAlignment alignment)
    {
        var text = value.Length > 20 ? value[..9] + "…" + value[^8..] : value;
        var formatted = new FormattedText($"{text}  {metric}", System.Globalization.CultureInfo.CurrentCulture,
            System.Windows.FlowDirection.LeftToRight, new Typeface("Segoe UI Variable Text"), 10.5,
            (Brush)FindResource("TextPrimaryBrush"), VisualTreeHelper.GetDpi(this).PixelsPerDip)
        { MaxTextWidth = Math.Max(20, width), TextAlignment = alignment, Trimming = TextTrimming.CharacterEllipsis };
        drawing.DrawText(formatted, origin);
    }

    private Brush MutedBrush() => (Brush)FindResource("TextSecondaryBrush");

    private Brush[] Palette() =>
    [
        (Brush)FindResource("AccentBrush"), Brushes.Teal, Brushes.MediumSlateBlue,
        Brushes.DarkOrange, Brushes.DeepPink, Brushes.MediumSeaGreen, Brushes.Goldenrod,
    ];

    private string FormatValue(long value) => useBytes ? FlowRow.FormatBytes(value) : value.ToString("N0");
    private sealed record Entry(string App, string Destination, long Value);
    private sealed record Node(string Name, long Value);
}
