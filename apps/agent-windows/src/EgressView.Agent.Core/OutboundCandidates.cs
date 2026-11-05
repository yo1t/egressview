namespace EgressView.Agent.Core;

public enum OutboundCandidateKind
{
    /// An application and destination not seen before learning finished.
    NewPair,
    /// A known pair, far above its own usual day.
    AboveUsual,
    /// This PC as a whole, far above its usual 24 hours.
    Machine,
}

/// Traffic worth a person's look, judged against this PC's own usual level
/// (P3-192, P3-193 phase 2).
///
/// A list to read, not an alert: replayed over 18 days of one Mac it found
/// four pairs it could not explain and nothing it could call harmful, so this
/// says "look here" and never "this is bad". The thresholds come from that one
/// Mac and will move.
public sealed record OutboundCandidate(
    OutboundCandidateKind Kind,
    DateTimeOffset At,
    string? Application,
    string? Destination,
    ulong BytesOut,
    ulong? UsualBytesOut);

public enum OutboundCandidateState
{
    /// Too few monitored hours to say what is usual. Not "all clear".
    Learning,
    /// Judged, but much of the traffic has no byte count, so an empty list
    /// says little.
    LowByteCoverage,
    Ready,
}

/// <param name="MonitoredHours">How much has been learned so far.</param>
/// <param name="ByteCoverageShare">Meaningful once learned.</param>
/// <param name="Candidates">Newest first, at most <see cref="OutboundCandidateRules.ListLimit"/>.</param>
/// <param name="Total">How many there were before the list stopped.</param>
public sealed record OutboundCandidateReport(
    OutboundCandidateState State,
    double MonitoredHours,
    double ByteCoverageShare,
    IReadOnlyList<OutboundCandidate> Candidates,
    int Total);

/// The same rules as `OutboundCandidates.swift`, held to the same cases in
/// `test/fixtures/outbound-candidates-cases.json`. Times are Unix seconds, as
/// there, so the arithmetic can be read side by side.
///
/// Worked out from the baseline tables each time rather than stored, so a
/// restart or a deleted stretch of history gives the answer the tables give.
public static class OutboundCandidateRules
{
    public sealed record Hour(double Start, long MonitoredSeconds, ulong BytesOut, long Observations, long ObservationsWithBytes);
    public readonly record struct PairKey(string Application, string Destination);
    public sealed record PairDay(double Day, PairKey Pair, ulong BytesOut);

    private const double DaySeconds = 86_400;

    /// A week of monitored time, however many calendar days that took.
    public const long LearningSeconds = 168 * 3600;
    /// A new pair is added up over a week: judged on its first day alone, one
    /// that sends a little every day would never appear.
    public const ulong NewPairBytes = 1 << 20;
    public const double NewPairWindow = 7 * DaySeconds;
    public const ulong AboveUsualBytes = 10 << 20;
    public const ulong AboveUsualFactor = 5;
    public const int AboveUsualMinimumDays = 3;
    public const double MachineFactor = 1.5;
    public const int MachineMinimumWindows = 168;
    /// Not measured across machines yet. Every connection on one Windows PC
    /// had a byte count (2026-11-05, 132 hours); the line comes from the Mac,
    /// where counting without packet headers leaves about 19% of TCP.
    public const double LowByteCoverageShare = 0.8;
    public const int CoverageHours = 168;
    public const double ListWindow = 14 * DaySeconds;
    public const int ListLimit = 50;

    /// Browsers go to new places for a living and a virtual machine hides what
    /// runs inside it: 220 of 415 new pairs in the replay on a Mac. Neither
    /// can be told apart by this rule, so the list says so instead of
    /// pretending. WebView2 is a browser inside whichever application hosts it.
    private static readonly HashSet<string> UnattributableNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "chrome", "msedge", "msedgewebview2", "firefox", "brave", "opera", "vivaldi", "arc", "iexplore",
        "vmmem", "vmmemwsl", "vmwp", "vmware-vmx", "vmnat", "wslhost", "wslrelay",
        "virtualboxvm", "vboxheadless", "vboxnetnat",
    };
    private static readonly string[] UnattributablePrefixes = ["qemu", "docker", "com.docker."];

    public static bool IsUnattributable(string application)
    {
        var name = application.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? application[..^4] : application;
        return UnattributableNames.Contains(name)
            || UnattributablePrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase));
    }

    public static OutboundCandidateReport Evaluate(
        IEnumerable<Hour> hours, IEnumerable<PairDay> pairDays, IReadOnlyDictionary<PairKey, double> firstSeen, DateTimeOffset now)
    {
        var ordered = hours.OrderBy(hour => hour.Start).ToList();
        long monitored = 0;
        double? learned = null;
        foreach (var hour in ordered)
        {
            monitored += hour.MonitoredSeconds;
            if (monitored >= LearningSeconds)
            {
                learned = hour.Start + 3600;
                break;
            }
        }
        if (learned is not { } learnedAt)
            return new(OutboundCandidateState.Learning, monitored / 3600.0, 0, [], 0);

        var days = pairDays.GroupBy(day => day.Pair).ToDictionary(group => group.Key, group => group.OrderBy(day => day.Day).ToList());
        var found = NewPairs(days, firstSeen, learnedAt).Concat(AboveUsual(days, learnedAt)).Concat(Machine(ordered, learnedAt));
        var cutoff = now.ToUnixTimeSeconds() - ListWindow;
        var recent = found.Where(candidate => candidate.At.ToUnixTimeSeconds() >= cutoff)
            .OrderByDescending(candidate => candidate.At)
            .ThenByDescending(TieBreak, StringComparer.Ordinal)
            .ToList();

        var latest = ordered.TakeLast(CoverageHours).ToList();
        var observations = latest.Sum(hour => hour.Observations);
        var withBytes = latest.Sum(hour => hour.ObservationsWithBytes);
        var share = observations == 0 ? 0 : (double)withBytes / observations;
        return new(share < LowByteCoverageShare ? OutboundCandidateState.LowByteCoverage : OutboundCandidateState.Ready,
            ordered.Sum(hour => hour.MonitoredSeconds) / 3600.0, share, recent.Take(ListLimit).ToList(), recent.Count);
    }

    /// The names are the Mac's, so a tie falls the same way on both.
    private static string TieBreak(OutboundCandidate candidate)
    {
        var kind = candidate.Kind switch
        {
            OutboundCandidateKind.NewPair => "newPair",
            OutboundCandidateKind.AboveUsual => "aboveUsual",
            _ => "machine",
        };
        return $"{kind}|{candidate.Application}|{candidate.Destination}";
    }

    private static DateTimeOffset Time(double seconds) => DateTimeOffset.FromUnixTimeSeconds((long)seconds);

    private static IEnumerable<OutboundCandidate> NewPairs(
        Dictionary<PairKey, List<PairDay>> pairs, IReadOnlyDictionary<PairKey, double> firstSeen, double learnedAt)
    {
        foreach (var (pair, days) in pairs)
        {
            if (!firstSeen.TryGetValue(pair, out var first) || first < learnedAt || IsUnattributable(pair.Application)) continue;
            ulong sent = 0;
            foreach (var day in days)
            {
                if (day.Day + DaySeconds <= first || day.Day >= first + NewPairWindow) continue;
                sent = unchecked(sent + day.BytesOut);
                if (sent < NewPairBytes) continue;
                yield return new(OutboundCandidateKind.NewPair, Time(day.Day), pair.Application, pair.Destination, sent, null);
                break;
            }
        }
    }

    /// Against the 90th percentile, and without the days already listed: with
    /// the largest day as the yardstick, one 8.6 GiB send hid everything under
    /// 25 GiB from then on.
    private static IEnumerable<OutboundCandidate> AboveUsual(Dictionary<PairKey, List<PairDay>> pairs, double learnedAt)
    {
        foreach (var (pair, days) in pairs)
        {
            var usual = new List<ulong>();
            foreach (var day in days)
            {
                if (day.Day + DaySeconds > learnedAt && usual.Count >= AboveUsualMinimumDays)
                {
                    var yardstick = Percentile(usual.Order().ToList(), 0.9);
                    if (yardstick <= ulong.MaxValue / AboveUsualFactor
                        && day.BytesOut >= AboveUsualBytes && day.BytesOut >= yardstick * AboveUsualFactor)
                    {
                        yield return new(OutboundCandidateKind.AboveUsual, Time(day.Day), pair.Application, pair.Destination, day.BytesOut, yardstick);
                        continue;
                    }
                }
                usual.Add(day.BytesOut);
            }
        }
    }

    /// Over the last 24 fully monitored hours. One entry a day, for the
    /// largest window: a single burst stays in the sum for 24 hours.
    private static IEnumerable<OutboundCandidate> Machine(List<Hour> ordered, double learnedAt)
    {
        var full = ordered.Where(hour => hour.MonitoredSeconds >= ObservationStore.FullyMonitoredSeconds).ToList();
        if (full.Count < 24) return [];
        var usual = new List<ulong>();
        var waiting = new Queue<(double Start, ulong Sent)>();
        var byDay = new Dictionary<double, OutboundCandidate>();
        ulong sum = 0;
        for (var index = 0; index < 23; index++) sum = unchecked(sum + full[index].BytesOut);
        for (var index = 23; index < full.Count; index++)
        {
            sum = unchecked(sum + full[index].BytesOut);
            var start = full[index].Start;
            // A window overlaps the ones just before it, so it joins the
            // comparison only a day later.
            while (waiting.TryPeek(out var next) && start - next.Start >= DaySeconds)
            {
                Insert(next.Sent, usual);
                waiting.Dequeue();
            }
            var yardstick = usual.Count == 0 ? 0 : Percentile(usual, 0.99);
            if (start >= learnedAt && usual.Count >= MachineMinimumWindows && (double)sum > MachineFactor * yardstick)
            {
                var day = Math.Floor(start / DaySeconds) * DaySeconds;
                if (sum > (byDay.TryGetValue(day, out var held) ? held.BytesOut : 0))
                    byDay[day] = new(OutboundCandidateKind.Machine, Time(day), null, null, sum, yardstick);
            }
            else waiting.Enqueue((start, sum));
            sum = unchecked(sum - full[index - 23].BytesOut);
        }
        return byDay.Values;
    }

    private static void Insert(ulong value, List<ulong> sorted)
    {
        var at = sorted.BinarySearch(value);
        sorted.Insert(at < 0 ? ~at : at, value);
    }

    private static ulong Percentile(List<ulong> sorted, double p) => sorted[(int)(p * (sorted.Count - 1))];
}
