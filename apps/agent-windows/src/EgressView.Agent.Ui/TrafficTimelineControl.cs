using System.Windows;
using System.Windows.Media;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;
using Brushes = System.Windows.Media.Brushes;

namespace EgressView.Agent.Ui;

public sealed class TrafficTimelineControl : FrameworkElement
{
    private IReadOnlyList<AppTimelineAggregate> items = [];
    private bool useBytes;

    public void SetItems(IReadOnlyList<AppTimelineAggregate> value, bool bytes) { items = value; useBytes = bytes; InvalidateVisual(); }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var stroke = (Brush)FindResource("StrokeBrush");
        var baseline = Math.Max(1, ActualHeight - 25);
        drawing.DrawLine(new Pen(stroke, 1), new Point(0, baseline), new Point(ActualWidth, baseline));
        if (items.Count == 0) return;
        var series = items.Select(item => item.Application).Distinct().OrderBy(name => name == "Other").ThenBy(name => name).ToArray();
        var bucketCount = Math.Max(60, items.Max(item => item.Bucket) + 1);
        var values = items.ToDictionary(item => (item.Bucket, item.Application), item => useBytes ? item.Bytes : item.Connections);
        var totals = Enumerable.Range(0, bucketCount).Select(bucket => series.Sum(name => values.GetValueOrDefault((bucket, name)))).ToArray();
        var maximum = Math.Max(1, totals.Max());
        var width = ActualWidth / bucketCount;
        var palette = new[] { (Brush)FindResource("AccentBrush"), Brushes.Turquoise, Brushes.MediumSlateBlue, Brushes.DarkOrange, Brushes.Crimson, Brushes.MediumAquamarine, Brushes.DimGray };
        for (var bucket = 0; bucket < bucketCount; bucket++)
        {
            var y = baseline;
            for (var seriesIndex = 0; seriesIndex < series.Length; seriesIndex++)
            {
                var value = values.GetValueOrDefault((bucket, series[seriesIndex]));
                if (value <= 0) continue;
                var height = (baseline - 8) * value / maximum;
                y -= height;
                drawing.DrawRectangle(palette[seriesIndex % palette.Length], null,
                    new Rect(bucket * width + Math.Min(1.5, width * 0.1), y, Math.Max(1, width - Math.Min(3, width * 0.2)), height));
            }
        }
        var legendX = 0d;
        for (var index = 0; index < series.Length && legendX < ActualWidth - 60; index++)
        {
            drawing.DrawRoundedRectangle(palette[index % palette.Length], null, new Rect(legendX, baseline + 9, 9, 9), 2, 2);
            var label = new FormattedText(LocalizationManager.Application(series[index]), System.Globalization.CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
                new Typeface("Segoe UI Variable Text"), 9.5, (Brush)FindResource("TextSecondaryBrush"), VisualTreeHelper.GetDpi(this).PixelsPerDip)
            { MaxTextWidth = 82, Trimming = TextTrimming.CharacterEllipsis };
            drawing.DrawText(label, new Point(legendX + 13, baseline + 6));
            legendX += Math.Min(100, 20 + label.Width);
        }
    }
}
