namespace EgressView.Agent.Core;

/// One finished observation window, used for behavioural comparison.
///
/// Byte counters only arrive when a flow reports its final statistics, so
/// <see cref="ByteCoverage"/> makes that limitation explicit: an incomplete
/// window must never become either an alert or a misleading baseline.
///
/// Measured on Windows before porting any of this: 98.5% to 100% of
/// connections carry byte counts over periods from one hour to thirty days.
/// A detector built on numbers that were not there would have reported a
/// shortfall in measurement as a change in behaviour.
public sealed record OutboundTrafficWindow(
    DateTimeOffset StartedAt,
    ulong BytesOut,
    int ObservationCount,
    int ObservationsWithBytes,
    int ApplicationCount,
    int DestinationCount,
    ulong LargestApplicationBytesOut)
{
    public double ByteCoverage => ObservationCount > 0 ? (double)ObservationsWithBytes / ObservationCount : 0;
}

public enum OutboundAnomalyKind { LargeTransfer, DistributedTransfer }

public sealed record OutboundAnomalyFinding(
    OutboundAnomalyKind Kind,
    OutboundTrafficWindow Window,
    ulong BaselineMedianBytesOut,
    ulong AlertThresholdBytesOut);

/// Finds large outbound changes without claiming to identify malware.
///
/// Median and median absolute deviation resist one-off backups becoming the
/// new normal. The absolute and ratio floors stop a quiet baseline from
/// turning a small upload into an alarm: on a machine that normally sends a
/// megabyte an hour, three times normal is still nothing worth waking anyone
/// for.
///
/// Ported from the Mac Agent's OutboundAnomalyDetector, thresholds and all.
/// The two platforms must agree about what counts as unusual, or the same
/// laptop moved between them tells two different stories.
public sealed class OutboundAnomalyDetector(OutboundAnomalyDetector.Configuration? configuration = null)
{
    public sealed record Configuration
    {
        /// 96 fifteen-minute windows: a full day. Less than that and "normal"
        /// has not been observed, only guessed at.
        public int MinimumBaselineWindows { get; init; } = 96;
        public int MinimumObservations { get; init; } = 10;
        public double MinimumByteCoverage { get; init; } = 0.8;
        public ulong AbsoluteBytesFloor { get; init; } = 100UL * 1024 * 1024;
        public ulong MinimumIncreaseBytes { get; init; } = 16UL * 1024 * 1024;
        public double MedianMultiplier { get; init; } = 3.0;
        public double MadMultiplier { get; init; } = 6.0;
        public int DistributedMinimumApplications { get; init; } = 3;
        public int DistributedMinimumDestinations { get; init; } = 12;
        public double DistributedMaximumLargestAppShare { get; init; } = 0.6;
    }

    public Configuration Settings { get; } = configuration ?? new Configuration();

    /// <returns>Null when nothing unusual happened, and null when there is not
    /// enough measured history to have an opinion. Those are different states
    /// and the caller must not present either as "no anomalies found".</returns>
    public OutboundAnomalyFinding? Evaluate(OutboundTrafficWindow current, IReadOnlyList<OutboundTrafficWindow> baseline)
    {
        if (current.ObservationCount < Settings.MinimumObservations) return null;
        if (current.ByteCoverage < Settings.MinimumByteCoverage) return null;

        // A window that could not be measured is not evidence of a quiet
        // period, so it must not lower the baseline either.
        var usable = baseline
            .Where(window => window.ObservationCount >= Settings.MinimumObservations
                && window.ByteCoverage >= Settings.MinimumByteCoverage)
            .ToArray();
        if (usable.Length < Settings.MinimumBaselineWindows) return null;

        var values = usable.Select(window => window.BytesOut).ToArray();
        var median = Median(values);
        var mad = Median(values.Select(value => value >= median ? value - median : median - value).ToArray());

        var deviation = Math.Max(Settings.MinimumIncreaseBytes, Scaled(mad, Settings.MadMultiplier));
        var threshold = Max(
            Settings.AbsoluteBytesFloor,
            Scaled(median, Settings.MedianMultiplier),
            AddSaturating(median, deviation));
        if (current.BytesOut < threshold) return null;

        // One process sending a lot and a dozen processes each sending some
        // are different events. The second is the one a person would never
        // spot by looking at a list sorted by size.
        var largestShare = current.BytesOut == 0
            ? 1
            : (double)current.LargestApplicationBytesOut / current.BytesOut;
        var distributed = current.ApplicationCount >= Settings.DistributedMinimumApplications
            && current.DestinationCount >= Settings.DistributedMinimumDestinations
            && largestShare <= Settings.DistributedMaximumLargestAppShare;

        return new OutboundAnomalyFinding(
            distributed ? OutboundAnomalyKind.DistributedTransfer : OutboundAnomalyKind.LargeTransfer,
            current, median, threshold);
    }

    private static ulong Median(ulong[] values)
    {
        if (values.Length == 0) return 0;
        var sorted = values.Order().ToArray();
        var middle = sorted.Length / 2;
        if (sorted.Length % 2 != 0) return sorted[middle];
        var lower = sorted[middle - 1];
        var upper = sorted[middle];
        // Not (lower + upper) / 2: two counters near the top of the range sum
        // past it, and the average of two large windows would come back small.
        return lower + (upper - lower) / 2;
    }

    private static ulong Scaled(ulong value, double multiplier)
    {
        var result = value * multiplier;
        if (double.IsNaN(result) || result >= ulong.MaxValue) return ulong.MaxValue;
        return result <= 0 ? 0 : (ulong)result;
    }

    private static ulong AddSaturating(ulong left, ulong right) =>
        left > ulong.MaxValue - right ? ulong.MaxValue : left + right;

    private static ulong Max(ulong first, ulong second, ulong third) => Math.Max(first, Math.Max(second, third));
}
