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
    /// The most nodes ever named per side, before the height available cuts
    /// it further. Past this the ribbons are too thin to read, so the rest is
    /// summed into one visible band instead of being dropped: a chart that
    /// silently omits most of its data looks complete while showing a
    /// fraction.
    private const int TopNodes = 7;
    private const double LabelWidth = 132;
    private const double NodeWidth = 9;
    private const double NodeGap = 6;
    private const double LineHeight = 14;
    private const double TopMargin = 8;
    /// Below this a node is a line rather than a band, and its label points at
    /// something the reader cannot see.
    private const double MinNodeHeight = 4;

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
        //
        // How many to name is decided by how thick each would be drawn, not by
        // a fixed count. Measured by data volume one destination often holds
        // most of the total, and the rest then arrive as sub-pixel slivers
        // under a stack of labels nobody can match to them. Naming fewer and
        // letting the band carry the remainder says the same thing and can be
        // read.
        var height = Math.Max(1, ActualHeight - TopMargin * 2);
        var appNames = TopNames(entries.GroupBy(entry => entry.App), other, height);
        var destinationNames = TopNames(entries.GroupBy(entry => entry.Destination), other, height);
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
            // No minimum: a ribbon padded up to a visible width stops summing
            // to its node, and the stack then spills past the node it belongs
            // to. A share too small to see is better shown as nothing than as
            // a share it does not have.
            var thickness = entry.Value * scale;
            var sourceTop = source.Top + appOffsets[entry.App];
            var targetTop = target.Top + destinationOffsets[entry.Destination];
            appOffsets[entry.App] += thickness;
            destinationOffsets[entry.Destination] += thickness;
            if (thickness < 0.35) continue;

            var brush = entry.App == other ? MutedBrush() : palette[appIndex[entry.App] % palette.Length];
            // Filled between two edges rather than stroked along one. A stroke
            // is measured perpendicular to the curve, so wherever the curve
            // slopes it covers more vertical space than its share -- which is
            // why neighbouring ribbons appeared to overlap even though their
            // ends tile exactly.
            var path = new StreamGeometry();
            var control = (rightX - leftX) * 0.48;
            using (var context = path.Open())
            {
                context.BeginFigure(new Point(leftX + NodeWidth, sourceTop), true, true);
                context.BezierTo(new Point(leftX + control, sourceTop), new Point(rightX - control, targetTop),
                    new Point(rightX, targetTop), true, false);
                context.LineTo(new Point(rightX, targetTop + thickness), true, false);
                context.BezierTo(new Point(rightX - control, targetTop + thickness),
                    new Point(leftX + control, sourceTop + thickness),
                    new Point(leftX + NodeWidth, sourceTop + thickness), true, false);
            }
            path.Freeze();
            drawing.PushOpacity(0.34);
            drawing.DrawGeometry(brush, null, path);
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
        foreach (var (node, y) in Declutter(apps, appRects, ActualHeight))
            DrawLabel(drawing, node.Name, FormatValue(node.Value), new Point(0, y), LabelWidth - 10, TextAlignment.Left);
        foreach (var (node, y) in Declutter(destinations, destinationRects, ActualHeight))
            DrawLabel(drawing, node.Name, FormatValue(node.Value), new Point(rightX + NodeWidth + 10, y),
                Math.Max(20, ActualWidth - rightX - NodeWidth - 11), TextAlignment.Right);
    }

    /// The nodes worth naming: the largest few, cut short at the first one
    /// too thin to see. A named node the reader cannot find on the chart is
    /// worse than an honest remainder, because it looks like it is there.
    private static string[] TopNames(IEnumerable<IGrouping<string, Entry>> groups, string other, double height)
    {
        var ranked = groups.Select(group => new Node(group.Key, group.Sum(entry => entry.Value)))
            .OrderByDescending(node => node.Value)
            .Take(TopNodes)
            .ToArray();
        var total = ranked.Length == 0 ? 0 : groups.Sum(group => group.Sum(entry => entry.Value));
        if (total <= 0) return [];

        var named = 0;
        for (var index = 0; index < ranked.Length; index++)
        {
            // Room for this many named nodes plus the remainder band, so the
            // gaps between them are paid for before the thickness is judged.
            var usable = height - NodeGap * (index + 1);
            if (usable <= 0 || ranked[index].Value * usable / total < MinNodeHeight) break;
            named = index + 1;
        }
        return ranked.Take(named).Select(node => node.Name).Where(name => name != other).ToArray();
    }

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
            var nodeHeight = node.Value * scale;
            result[node.Name] = new Rect(x, y, NodeWidth, nodeHeight);
            y += nodeHeight + NodeGap;
        }
        return result;
    }

    /// Labels centred on their node, then separated.
    ///
    /// Pushing each one down past the last leaves the bottom of the list
    /// hanging off the control, which silently loses the folded remainder --
    /// the one node whose absence the reader cannot detect. So the run is
    /// pushed back up from the bottom afterwards, and only genuinely
    /// unfittable labels are dropped.
    private static List<(Node Node, double Y)> Declutter(Node[] nodes, Dictionary<string, Rect> rects, double bottom)
    {
        var placed = new List<(Node Node, double Y)>();
        var previous = double.NegativeInfinity;
        foreach (var node in nodes)
        {
            var rect = rects[node.Name];
            var y = Math.Max(rect.Top + rect.Height / 2 - LineHeight / 2, previous + LineHeight);
            previous = y;
            placed.Add((node, y));
        }

        var overflow = placed.Count == 0 ? 0 : placed[^1].Y + LineHeight - bottom;
        if (overflow <= 0) return placed;
        for (var index = placed.Count - 1; index >= 0; index--)
        {
            var lifted = placed[index].Y - overflow;
            if (index > 0 && lifted < placed[index - 1].Y + LineHeight)
                overflow = placed[index - 1].Y + LineHeight - lifted;
            placed[index] = (placed[index].Node, lifted);
        }
        return placed.Where(entry => entry.Y >= 0).ToList();
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
