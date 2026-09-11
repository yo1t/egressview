namespace EgressView.Agent.Core;

public sealed record TimelineAxisScale(double Top, IReadOnlyList<int> Clipped, double? Peak)
{
    public const double OutlierRatio = 4;
    public bool HasClipping => Clipped.Count > 0;

    public static TimelineAxisScale Fit(IReadOnlyList<long> totals, bool allowClipping)
    {
        ArgumentNullException.ThrowIfNull(totals);
        var positive = totals.Where(value => value > 0).ToArray();
        if (positive.Length == 0) return new(0, [], null);
        var highest = positive.Max();
        if (!allowClipping) return new(highest, [], null);

        // Equal tallest buckets are all treated as the same spike. Compare
        // them with the next genuinely lower value, as the Mac Agent does.
        var runnerUp = positive.Where(value => value < highest).DefaultIfEmpty(0).Max();
        if (runnerUp <= 0 || highest < runnerUp * OutlierRatio)
            return new(highest, [], null);

        var top = runnerUp * 1.25;
        var clipped = totals.Select((value, index) => (value, index))
            .Where(entry => entry.value > top)
            .Select(entry => entry.index)
            .ToArray();
        return new(top, clipped, highest);
    }
}
