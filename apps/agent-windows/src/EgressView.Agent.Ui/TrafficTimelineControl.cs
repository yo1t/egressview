using System.Windows;
using System.Windows.Media;
using EgressView.Agent.Core;
using Brush = System.Windows.Media.Brush;
using Pen = System.Windows.Media.Pen;
using Point = System.Windows.Point;

namespace EgressView.Agent.Ui;

public sealed class TrafficTimelineControl : FrameworkElement
{
    private IReadOnlyList<HourlySummary> items = [];

    public void SetItems(IReadOnlyList<HourlySummary> value) { items = value; InvalidateVisual(); }

    protected override void OnRender(DrawingContext drawing)
    {
        base.OnRender(drawing);
        var stroke = (Brush)FindResource("StrokeBrush");
        var accent = (Brush)FindResource("AccentBrush");
        drawing.DrawLine(new Pen(stroke, 1), new Point(0, ActualHeight - 1), new Point(ActualWidth, ActualHeight - 1));
        if (items.Count == 0) return;
        var buckets = items.GroupBy(item => item.BucketStart).OrderBy(group => group.Key)
            .Select(group => group.Sum(item => item.ObservationCount)).ToArray();
        var maximum = Math.Max(1, buckets.Max());
        var width = ActualWidth / buckets.Length;
        for (var index = 0; index < buckets.Length; index++)
        {
            var height = (ActualHeight - 8) * buckets[index] / maximum;
            drawing.DrawRoundedRectangle(accent, null,
                new Rect(index * width + Math.Min(2, width * 0.1), ActualHeight - height - 1, Math.Max(1, width - Math.Min(4, width * 0.2)), height), 2, 2);
        }
    }
}
