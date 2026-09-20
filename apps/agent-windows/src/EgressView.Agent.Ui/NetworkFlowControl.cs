using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;
using Brushes = System.Windows.Media.Brushes;
using Size = System.Windows.Size;

namespace EgressView.Agent.Ui;

/// <summary>Application-to-destination Sankey, following the Mac Agent layout.</summary>
public sealed class NetworkFlowControl : FrameworkElement
{
    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

    private const double NodeWidth = 9;
    private const double NodeGap = 6;
    /// The pitch of one name row, and the size the names are drawn at.
    ///
    /// The names were 10.5 point because the card could not scroll: every row
    /// had to fit a fixed height, so the only way to show more of them was to
    /// make them smaller. The card scrolls now, so it is not a trade any more,
    /// and a destination name is the thing a reader came to the card to read.
    private const double LineHeight = 20;
    private const double FontSize = 12;
    private const double TopMargin = 8;

    /// How many names each side keeps before the rest becomes one band.
    ///
    /// Thirty, which is the Mac Agent's number and was measured there: of 656
    /// destinations in a day the remainder falls from 34% at eight names to
    /// 21% at thirty, and stops falling after that because the tail is long.
    ///
    /// This used to be "as many as fit the card", which on a 380-point card is
    /// about twenty and on a short window far fewer -- so the same period told
    /// two different stories depending on how tall the window happened to be.
    /// The card scrolls now, so the extra names cost height in a scroll view
    /// rather than on screen.
    private const int MaximumNames = 30;

    /// How wide each column of names is allowed to be.
    ///
    /// A share of the card rather than a fixed 132 points. Hostnames are long
    /// and the middle of the diagram is the part that can afford to lose
    /// width: a ribbon says the same thing at 300 points as at 400, and a
    /// destination truncated to "pkg-co...t.com" says almost nothing.
    private const double MinimumLabelWidth = 140;
    private const double MaximumLabelWidth = 260;
    private const double LabelShareOfWidth = 0.31;

    /// The gap between a name and its figure, and between the text and the
    /// node it belongs to.
    private const double LabelGap = 10;

    /// The dot that carries a row's colour out to its name.
    ///
    /// A ribbon's colour is the only thing tying it to the row that names it,
    /// and the rows are a column away from the drawing. Without this the
    /// reader matches them by position, which is exactly what the declutter
    /// above is allowed to disturb.
    private const double DotSize = 7;
    private const double DotGap = 6;

    private Model? model;
    private bool useBytes;

    public void SetItems(IReadOnlyList<AppDestinationAggregate> value, bool bytes, bool names)
    {
        var links = names ? value.Select(item => item with { Destination = item.DestinationName }).ToArray() : value;
        useBytes = bytes;
        model = Build(links);
        // The card is as tall as the names need, and scrolls. Measuring has to
        // be redone before drawing, or a period with more names than the last
        // one is drawn into the height the last one asked for.
        InvalidateMeasure();
        InvalidateVisual();
    }

    /// As tall as the longer column needs, so nothing is laid out into a
    /// height it does not have. The ribbons are drawn against this same
    /// height, which is why they keep meeting their names while scrolling.
    protected override Size MeasureOverride(Size availableSize)
    {
        var rows = model is null ? 0 : Math.Max(model.Apps.Length, model.Destinations.Length);
        var height = TopMargin * 2 + Math.Max(rows, 1) * LineHeight;
        var width = double.IsInfinity(availableSize.Width) ? 0 : availableSize.Width;
        return new Size(width, height);
    }

    /// Everything the drawing needs, worked out once when the data arrives.
    ///
    /// Held rather than recomputed per render because the height depends on
    /// it: measuring and drawing have to agree about how many rows there are,
    /// and the only way to guarantee that is for them to read the same answer.
    private sealed record Model(Node[] Apps, Node[] Destinations, Entry[] Folded, long Total);

    private Model? Build(IReadOnlyList<AppDestinationAggregate> links)
    {
        if (links.Count == 0) return null;
        var other = LocalizationManager.Text("FlowOther");
        var entries = links
            .Select(link => new Entry(LocalizationManager.Application(link.Application), link.Destination,
                useBytes ? link.Bytes : link.Connections))
            .Where(entry => entry.Value > 0)
            .ToArray();
        if (entries.Length == 0) return null;

        // Keep every value: the ones outside the top N are folded into a band
        // rather than discarded, so the ribbons still add up to the total the
        // summary card reports.
        var appNames = TopNames(entries.GroupBy(entry => entry.App), other);
        var destinationNames = TopNames(entries.GroupBy(entry => entry.Destination), other);
        var folded = entries
            .GroupBy(entry => (App: Bucket(entry.App, appNames, other), Destination: Bucket(entry.Destination, destinationNames, other)))
            .Select(group => new Entry(group.Key.App, group.Key.Destination, group.Sum(entry => entry.Value)))
            .ToArray();
        var total = folded.Sum(entry => entry.Value);
        if (total <= 0) return null;
        return new Model(Order(folded.GroupBy(entry => entry.App), other),
            Order(folded.GroupBy(entry => entry.Destination), other), folded, total);
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        if (model is null || ActualWidth < 260 || ActualHeight < 60) return;
        var other = LocalizationManager.Text("FlowOther");
        var (apps, destinations, folded, total) = model;
        var height = Math.Max(1, ActualHeight - TopMargin * 2);

        // One scale for node heights and ribbon thickness. Two scales make the
        // ribbons leave their node, which is what a reader notices first.
        var tallest = Math.Max(apps.Length, destinations.Length);
        var usable = Math.Max(1, height - NodeGap * Math.Max(0, tallest - 1));
        var scale = usable / (double)total;

        var labelWidth = Math.Clamp(ActualWidth * LabelShareOfWidth, MinimumLabelWidth, MaximumLabelWidth);
        var leftX = labelWidth;
        var rightX = Math.Max(leftX + 40, ActualWidth - labelWidth - NodeWidth);
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
        // The figure goes on the side nearest the diagram on both columns, so
        // the two run down the middle where a reader compares them, and the
        // names sit on the outside where there is room to be long. The dot
        // goes on the outer edge, where it starts the row.
        DrawLabels(drawing, Declutter(apps, appRects, ActualHeight), 0, labelWidth - LabelGap,
            figureInside: true,
            node => node.Name == other ? MutedBrush() : palette[appIndex[node.Name] % palette.Length]);
        DrawLabels(drawing, Declutter(destinations, destinationRects, ActualHeight), rightX + NodeWidth + LabelGap,
            Math.Max(20, ActualWidth - rightX - NodeWidth - LabelGap - 1),
            figureInside: false, _ => secondary);
    }

    /// The nodes worth naming: the largest thirty, with the rest folded into
    /// one honest band.
    private static string[] TopNames(IEnumerable<IGrouping<string, Entry>> groups, string other) =>
        groups.Select(group => new Node(group.Key, group.Sum(entry => entry.Value)))
            .OrderByDescending(node => node.Value)
            .Take(MaximumNames)
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

    /// A column of names and figures, the figure always on the side nearest
    /// the diagram.
    ///
    /// The figures are given one width for the whole column, so the names do
    /// not shift about as the numbers change between refreshes, and every name
    /// is measured against the same space.
    private void DrawLabels(DrawingContext drawing, IReadOnlyList<(Node Node, double Y)> placed,
        double originX, double width, bool figureInside, Func<Node, Brush> dotBrush)
    {
        if (placed.Count == 0) return;
        var culture = System.Globalization.CultureInfo.CurrentCulture;
        var typeface = new Typeface("Segoe UI Variable Text");
        var brush = (Brush)FindResource("TextPrimaryBrush");
        var secondary = (Brush)FindResource("TextSecondaryBrush");
        var pixelsPerDip = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        FormattedText Text(string text, Brush colour) => new(text, culture,
            System.Windows.FlowDirection.LeftToRight, typeface, FontSize, colour, pixelsPerDip);
        double Measure(string text) => Text(text, brush).WidthIncludingTrailingWhitespace;

        var metrics = placed.Select(entry => FormatValue(entry.Node.Value)).ToArray();
        var figureWidth = metrics.Length == 0 ? 0 : metrics.Max(Measure);
        var nameWidth = Math.Max(20, width - figureWidth - LabelGap - DotSize - DotGap);
        var nameWidths = Enumerable.Repeat(nameWidth, placed.Count).ToArray();
        var fitted = SankeyLabelLayout.FitDistinct(placed.Select(entry => entry.Node.Name).ToArray(), nameWidths, Measure);

        for (var index = 0; index < placed.Count; index++)
        {
            // Width fitting happens exactly once above with the same font and
            // DPI. Do not ask WPF to append a second ellipsis here.
            var name = Text(fitted[index], brush);
            var figure = Text(metrics[index], secondary);
            var y = placed[index].Y;
            var dot = dotBrush(placed[index].Node);
            // Centred on the text it belongs to, using the text's own measured
            // height rather than the row pitch: the two differ, and a dot
            // aligned to the pitch sits low on every row.
            var middle = y + name.Height / 2;
            if (figureInside)
            {
                // Source column: the dot, then the name, then the figure
                // against the diagram.
                drawing.DrawEllipse(dot, null,
                    new Point(originX + DotSize / 2, middle), DotSize / 2, DotSize / 2);
                drawing.DrawText(name, new Point(originX + DotSize + DotGap, y));
                drawing.DrawText(figure,
                    new Point(originX + width - figure.WidthIncludingTrailingWhitespace, y));
            }
            else
            {
                // Destination column, the mirror of it: the figure against the
                // diagram, the dot against the outer edge.
                drawing.DrawText(figure, new Point(originX, y));
                drawing.DrawEllipse(dot, null,
                    new Point(originX + width - DotSize / 2, middle), DotSize / 2, DotSize / 2);
                drawing.DrawText(name,
                    new Point(originX + width - DotSize - DotGap - name.WidthIncludingTrailingWhitespace, y));
            }
        }
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
