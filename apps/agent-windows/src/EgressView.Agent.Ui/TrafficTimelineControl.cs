using System.Windows;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using System.Globalization;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;
using Brushes = System.Windows.Media.Brushes;

namespace EgressView.Agent.Ui;

public sealed class TrafficTimelineControl : FrameworkElement
{
    protected override AutomationPeer OnCreateAutomationPeer() => new FrameworkElementAutomationPeer(this);

    private IReadOnlyList<AppTimelineAggregate> items = [];
    private bool useBytes;
    private DateTimeOffset from;
    private DateTimeOffset to;

    public void SetItems(IReadOnlyList<AppTimelineAggregate> value, bool bytes, DateTimeOffset periodFrom, DateTimeOffset periodTo)
    {
        items = value;
        useBytes = bytes;
        from = periodFrom;
        to = periodTo;
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var stroke = (Brush)FindResource("StrokeBrush");
        var secondary = (Brush)FindResource("TextSecondaryBrush");
        var pixelsPerDip = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        const double yAxisWidth = 58;
        const double plotTop = 8;
        const double xAxisHeight = 20;
        const double legendHeight = 22;
        var plotLeft = Math.Min(yAxisWidth, Math.Max(0, ActualWidth * 0.24));
        var plotRight = Math.Max(plotLeft + 1, ActualWidth);
        var baseline = Math.Max(plotTop + 1, ActualHeight - xAxisHeight - legendHeight);
        var plotHeight = Math.Max(1, baseline - plotTop);
        var plotWidth = Math.Max(1, plotRight - plotLeft);

        var series = items.Select(item => item.Application).Distinct().OrderBy(name => name == "Other").ThenBy(name => name).ToArray();
        var bucketCount = Math.Max(60, items.Count == 0 ? 0 : items.Max(item => item.Bucket) + 1);
        var values = items.ToDictionary(item => (item.Bucket, item.Application), item => useBytes ? item.Bytes : item.Connections);
        var totals = Enumerable.Range(0, bucketCount).Select(bucket => series.Sum(name => values.GetValueOrDefault((bucket, name)))).ToArray();
        var maximum = totals.Length == 0 ? 0 : totals.Max();
        var scaleMaximum = Math.Max(1, maximum);
        var gridBrush = stroke.Clone();
        gridBrush.Opacity = 0.45;
        var gridPen = new Pen(gridBrush, 1);
        for (var step = 0; step <= 2; step++)
        {
            var fraction = step / 2d;
            var y = baseline - plotHeight * fraction;
            drawing.DrawLine(gridPen, new Point(plotLeft, y), new Point(plotRight, y));
            DrawRightAligned(drawing, FormatAxisValue(maximum * fraction), plotLeft - 7, y - 7, secondary, pixelsPerDip);
        }

        DrawTimeAxis(drawing, plotLeft, plotRight, baseline + 3, secondary, pixelsPerDip);

        var width = plotWidth / bucketCount;
        var palette = new[] { (Brush)FindResource("AccentBrush"), Brushes.Turquoise, Brushes.MediumSlateBlue, Brushes.DarkOrange, Brushes.Crimson, Brushes.MediumAquamarine, Brushes.DimGray };
        for (var bucket = 0; bucket < bucketCount; bucket++)
        {
            var y = baseline;
            for (var seriesIndex = 0; seriesIndex < series.Length; seriesIndex++)
            {
                var value = values.GetValueOrDefault((bucket, series[seriesIndex]));
                if (value <= 0) continue;
                var height = plotHeight * value / scaleMaximum;
                y -= height;
                drawing.DrawRectangle(palette[seriesIndex % palette.Length], null,
                    new Rect(plotLeft + bucket * width + Math.Min(1.5, width * 0.1), y, Math.Max(1, width - Math.Min(3, width * 0.2)), height));
            }
        }
        var legendX = plotLeft;
        var legendY = Math.Min(ActualHeight - 10, baseline + xAxisHeight + 2);
        for (var index = 0; index < series.Length && legendX < ActualWidth - 45; index++)
        {
            drawing.DrawRoundedRectangle(palette[index % palette.Length], null, new Rect(legendX, legendY - 3, 9, 9), 2, 2);
            var label = new FormattedText(LocalizationManager.Application(series[index]), CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
                new Typeface("Segoe UI Variable Text"), 9.5, secondary, pixelsPerDip)
            { MaxTextWidth = 82, Trimming = TextTrimming.CharacterEllipsis };
            drawing.DrawText(label, new Point(legendX + 13, legendY - 6));
            legendX += Math.Min(100, 20 + label.Width);
        }
    }

    private string FormatAxisValue(double value)
    {
        var rounded = (long)Math.Round(value, MidpointRounding.AwayFromZero);
        return useBytes ? FlowRow.FormatBytes(rounded) : rounded.ToString("N0", CultureInfo.CurrentCulture);
    }

    private void DrawTimeAxis(DrawingContext drawing, double left, double right, double y, Brush brush, double pixelsPerDip)
    {
        if (to <= from) return;
        var midpoint = from + TimeSpan.FromTicks((to - from).Ticks / 2);
        var values = new[] { from, midpoint, to };
        for (var index = 0; index < values.Length; index++)
        {
            var label = new FormattedText(FormatTime(values[index]), CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
                new Typeface("Segoe UI Variable Text"), 9.5, brush, pixelsPerDip);
            var anchor = index switch { 0 => left, 1 => (left + right) / 2, _ => right };
            var x = index switch { 0 => anchor, 1 => anchor - label.Width / 2, _ => anchor - label.Width };
            drawing.DrawText(label, new Point(Math.Max(left, Math.Min(right - label.Width, x)), y));
        }
    }

    private string FormatTime(DateTimeOffset value)
    {
        var local = value.LocalDateTime;
        return (to - from).TotalHours > 24
            ? local.ToString("M/d", CultureInfo.CurrentCulture)
            : local.ToString("t", CultureInfo.CurrentCulture);
    }

    private static void DrawRightAligned(DrawingContext drawing, string value, double right, double y, Brush brush, double pixelsPerDip)
    {
        var label = new FormattedText(value, CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
            new Typeface("Segoe UI Variable Text"), 9.5, brush, pixelsPerDip);
        drawing.DrawText(label, new Point(Math.Max(0, right - label.Width), y));
    }
}
