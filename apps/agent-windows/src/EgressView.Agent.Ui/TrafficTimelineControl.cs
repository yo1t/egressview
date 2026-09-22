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
    private int buckets;
    private DateTimeOffset from;
    private DateTimeOffset to;
    private IReadOnlyList<SleepPeriod> sleepPeriods = [];
    private IReadOnlyList<MonitoringGap> monitoringGaps = [];

    /// The distance between the diagonal strokes that mark missing time.
    private const double HatchSpacing = 6;

    /// The narrowest a gap may be drawn: one stroke's worth.
    ///
    /// A thirty-second outage in a six-hour period is a seventh of a percent
    /// of the width -- under a pixel, drawn to scale, and an outage that
    /// rounds away is the whole defect: the chart goes back to showing
    /// "nothing left this PC" for a stretch it knows nothing about.
    ///
    /// The floor is the hatch spacing rather than a smaller number that would
    /// also survive a pixel comparison. Narrower than one stroke, the band
    /// stops being hatching and becomes a tick -- visible to a test, but no
    /// longer the pattern that means "no record" everywhere else on the
    /// chart. Being legible and being detectable are not the same bar.
    ///
    /// It overstates a very short gap, which is the right way to be wrong
    /// here: the band says a gap is there, and the legend says how long.
    private const double MinimumGapWidth = HatchSpacing;

    public void SetItems(IReadOnlyList<AppTimelineAggregate> value, bool bytes, DateTimeOffset periodFrom, DateTimeOffset periodTo,
        IReadOnlyList<SleepPeriod>? sleeps = null, int bucketCount = 0, IReadOnlyList<MonitoringGap>? gaps = null)
    {
        items = value;
        useBytes = bytes;
        buckets = bucketCount;
        from = periodFrom;
        to = periodTo;
        sleepPeriods = sleeps ?? [];
        monitoringGaps = gaps ?? [];
        InvalidateVisual();
    }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var stroke = (Brush)FindResource("StrokeBrush");
        var secondary = (Brush)FindResource("TextSecondaryBrush");
        var pixelsPerDip = VisualTreeHelper.GetDpi(this).PixelsPerDip;
        var typeface = new Typeface("Segoe UI Variable Text");
        var axisPrototype = new FormattedText("0", CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
            typeface, 9.5, secondary, pixelsPerDip);
        const double yAxisWidth = 58;
        const double xAxisHeight = 20;
        const double legendHeight = 22;
        var plotTop = Math.Ceiling(axisPrototype.Height / 2) + 2;
        var plotLeft = Math.Min(yAxisWidth, Math.Max(0, ActualWidth * 0.24));
        var plotRight = Math.Max(plotLeft + 1, ActualWidth);

        var series = items.Select(item => item.Application).Distinct().OrderBy(name => name == "Other").ThenBy(name => name).ToArray();
        // The number the period was divided into, not a guess from the data.
        // Empty buckets at the end are still buckets: a period whose last hour
        // was quiet must not squeeze the rest of the day to fill the card.
        var bucketCount = buckets > 0
            ? buckets
            : Math.Max(60, items.Count == 0 ? 0 : items.Max(item => item.Bucket) + 1);
        var values = items.ToDictionary(item => (item.Bucket, item.Application), item => useBytes ? item.Bytes : item.Connections);
        var totals = Enumerable.Range(0, bucketCount).Select(bucket => series.Sum(name => values.GetValueOrDefault((bucket, name)))).ToArray();
        var axis = TimelineAxisScale.Fit(totals, useBytes);
        var scaleMaximum = Math.Max(1, axis.Top);
        var clipNoteHeight = axis.HasClipping ? 30 : 0;
        var baseline = Math.Max(plotTop + 1, ActualHeight - xAxisHeight - legendHeight - clipNoteHeight);
        var plotHeight = Math.Max(1, baseline - plotTop);
        var plotWidth = Math.Max(1, plotRight - plotLeft);
        var gridBrush = stroke.Clone();
        gridBrush.Opacity = 0.45;
        var gridPen = new Pen(gridBrush.Frozen(), 1).Frozen();
        // How many labels the height affords, not how many the axis has.
        //
        // Three numbers stacked in a card a hundred pixels tall become one
        // smudge, and a smudge is worse than two readable numbers: the middle
        // tick is an aid, while the maximum is what makes any bar mean
        // anything. So the middle goes first, and the zero after it. The
        // gridlines stay either way -- they cost no room and still say where
        // half is.
        var labelPitch = axisPrototype.Height + 4;
        var affordable = plotHeight >= labelPitch * 3 ? 3 : plotHeight >= labelPitch * 2 ? 2 : 1;
        for (var step = 0; step <= 2; step++)
        {
            var fraction = step / 2d;
            var y = baseline - plotHeight * fraction;
            drawing.DrawLine(gridPen, new Point(plotLeft, y), new Point(plotRight, y));
            var labelled = affordable switch { 3 => true, 2 => step != 1, _ => step == 2 };
            if (labelled) DrawRightAligned(drawing, FormatAxisValue(axis.Top * fraction), plotLeft - 7, y, secondary, pixelsPerDip);
        }

        DrawTimeAxis(drawing, plotLeft, plotRight, baseline + 3, secondary, pixelsPerDip);

        var width = plotWidth / bucketCount;
        var palette = new[] { (Brush)FindResource("AccentBrush"), Brushes.Turquoise, Brushes.MediumSlateBlue, Brushes.DarkOrange, Brushes.Crimson, Brushes.MediumAquamarine, Brushes.DimGray };
        drawing.PushClip(new RectangleGeometry(new Rect(plotLeft, plotTop, plotWidth, plotHeight)));
        if (to > from)
        {
            var sleepFill = Brushes.DodgerBlue.Clone();
            sleepFill.Opacity = 0.22;
            var sleepEdge = Brushes.DodgerBlue.Clone();
            sleepEdge.Opacity = 0.60;
            var sleepPen = new Pen(sleepEdge.Frozen(), 1).Frozen();
            var totalSeconds = (to - from).TotalSeconds;
            foreach (var period in sleepPeriods)
            {
                var start = Math.Clamp((period.Start - from).TotalSeconds / totalSeconds, 0, 1);
                var end = Math.Clamp((period.End - from).TotalSeconds / totalSeconds, 0, 1);
                if (end <= start) continue;
                var x = plotLeft + plotWidth * start;
                drawing.DrawRectangle(sleepFill, sleepPen,
                    new Rect(x, plotTop, Math.Max(1, plotWidth * (end - start)), plotHeight));
            }
            DrawMonitoringGaps(drawing, plotLeft, plotTop, plotWidth, plotHeight, secondary);
        }
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
        drawing.Pop();
        if (axis.HasClipping)
        {
            var warning = (Brush)FindResource("WarningBrush");
            foreach (var bucket in axis.Clipped)
            {
                var center = plotLeft + (bucket + 0.5) * width;
                var marker = new StreamGeometry();
                using (var context = marker.Open())
                {
                    context.BeginFigure(new Point(center, plotTop), true, true);
                    context.LineTo(new Point(center - 4, plotTop + 6), true, false);
                    context.LineTo(new Point(center + 4, plotTop + 6), true, false);
                }
                marker.Freeze();
                drawing.DrawGeometry(warning, null, marker);
            }
        }
        var legendX = plotLeft;
        var legendY = Math.Min(ActualHeight - 10, baseline + xAxisHeight + 2);
        for (var index = 0; index < series.Length && legendX + 35 < ActualWidth; index++)
        {
            drawing.DrawRoundedRectangle(palette[index % palette.Length], null, new Rect(legendX, legendY - 3, 9, 9), 2, 2);
            var label = new FormattedText(LocalizationManager.Application(series[index]), CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
                new Typeface("Segoe UI Variable Text"), 9.5, secondary, pixelsPerDip)
            { MaxTextWidth = Math.Max(1, Math.Min(82, ActualWidth - legendX - 14)), Trimming = TextTrimming.CharacterEllipsis };
            drawing.DrawText(label, new Point(legendX + 13, legendY - 6));
            legendX += Math.Min(100, 20 + label.Width);
        }
        if (axis.Peak is { } peak)
        {
            var noteText = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("TimelineClippedPeak"),
                axis.Clipped.Count, FormatAxisValue(peak));
            var note = new FormattedText(noteText, CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
                typeface, 9.5, secondary, pixelsPerDip)
            {
                MaxTextWidth = plotWidth,
                MaxTextHeight = clipNoteHeight,
                Trimming = TextTrimming.WordEllipsis,
            };
            drawing.DrawText(note, new Point(plotLeft, baseline + xAxisHeight + legendHeight));
            System.Windows.Automation.AutomationProperties.SetHelpText(this, noteText);
        }
        else System.Windows.Automation.AutomationProperties.SetHelpText(this, string.Empty);
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

    /// Draws the stretches with no record as diagonal hatching.
    ///
    /// Hatching rather than another translucent fill: a flat wash reads as a
    /// faint value, and the whole point is that there is no value here. The
    /// lines run behind the bars, so a bucket that is part covered still
    /// shows its traffic over the hatched part of itself.
    private void DrawMonitoringGaps(DrawingContext drawing, double plotLeft, double plotTop,
        double plotWidth, double plotHeight, Brush secondary)
    {
        if (monitoringGaps.Count == 0) return;
        var totalSeconds = (to - from).TotalSeconds;
        var fill = secondary.Clone();
        fill.Opacity = 0.10;
        fill.Freeze();
        var lineBrush = secondary.Clone();
        lineBrush.Opacity = 0.55;
        var hatchPen = new Pen(lineBrush.Frozen(), 1).Frozen();
        var edgeBrush = secondary.Clone();
        edgeBrush.Opacity = 0.75;
        var edgePen = new Pen(edgeBrush.Frozen(), 1).Frozen();

        foreach (var gap in monitoringGaps)
        {
            var start = Math.Clamp((gap.Start - from).TotalSeconds / totalSeconds, 0, 1);
            var end = Math.Clamp((gap.End - from).TotalSeconds / totalSeconds, 0, 1);
            if (end < start) continue;
            var x = plotLeft + plotWidth * start;
            var width = Math.Max(MinimumGapWidth, plotWidth * (end - start));
            // A gap that ends at the right edge must not be pushed past it by
            // the minimum width, or it stops lining up with its own time.
            x = Math.Min(x, plotLeft + plotWidth - width);
            var area = new Rect(x, plotTop, width, plotHeight);
            drawing.DrawRectangle(fill, null, area);
            drawing.PushClip(new RectangleGeometry(area));
            // Forty-five degrees, so the spacing is the same whichever way the
            // band is measured.
            for (var offset = -plotHeight; offset < width; offset += HatchSpacing)
                drawing.DrawLine(hatchPen, new Point(x + offset, plotTop + plotHeight), new Point(x + offset + plotHeight, plotTop));
            drawing.Pop();
            drawing.DrawLine(edgePen, new Point(x, plotTop), new Point(x, plotTop + plotHeight));
            drawing.DrawLine(edgePen, new Point(x + width, plotTop), new Point(x + width, plotTop + plotHeight));
        }
    }

    private static void DrawRightAligned(DrawingContext drawing, string value, double right, double centerY, Brush brush, double pixelsPerDip)
    {
        var label = new FormattedText(value, CultureInfo.CurrentCulture, System.Windows.FlowDirection.LeftToRight,
            new Typeface("Segoe UI Variable Text"), 9.5, brush, pixelsPerDip);
        drawing.DrawText(label, new Point(Math.Max(0, right - label.Width), centerY - label.Height / 2));
    }
}
