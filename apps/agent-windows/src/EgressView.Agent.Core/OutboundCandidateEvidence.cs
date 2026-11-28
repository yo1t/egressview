namespace EgressView.Agent.Core;

/// One destination name and address used by one application, summed over
/// the evidence window.
/// <param name="Hostname">The name the baseline counted it under, or null
/// when it went by address alone.</param>
public sealed record OutboundEvidenceFlow(
    string Application, string? Hostname, string Address, ulong BytesOut, long Connections,
    DateTimeOffset FirstAt, DateTimeOffset LastAt);

/// The connections behind one candidate, read from the raw history, and how
/// much of that time the Agent could see (P3-194, as on the Mac:
/// `OutboundCandidateEvidence` in `OutboundCandidateTriage.swift`).
/// <param name="Flows">Largest first, at most <see cref="FlowLimit"/>.</param>
/// <param name="FlowTotal">How many there were before the limit.</param>
/// <param name="BytesOut">All of them, not just the ones shown.</param>
/// <param name="MonitoredSeconds">Of the window, how much was monitored.</param>
/// <param name="ByteShare">Of the connections the baseline counted in the
/// window, how many had a byte count. Null when there were none.</param>
/// <param name="RawHistoryIsPartial">The raw history begins after the window
/// starts, so some connections are no longer kept one by one.</param>
public sealed record OutboundCandidateEvidence(
    DateTimeOffset Start, DateTimeOffset End, IReadOnlyList<OutboundEvidenceFlow> Flows, int FlowTotal, ulong BytesOut,
    long MonitoredSeconds, double? ByteShare, bool RawHistoryIsPartial)
{
    public const int FlowLimit = 20;

    /// Less than this and the amount shown may be well short of what left.
    public const double FullCoverageShare = 0.95;

    /// Monitoring stopped for part of the window, connections went without a
    /// byte count, or the raw history no longer reaches back: what was sent
    /// may be more than shown.
    public bool MayUndercount =>
        MonitoredSeconds < (End - Start).TotalSeconds * FullCoverageShare
        || (ByteShare ?? 1) < FullCoverageShare
        || RawHistoryIsPartial;

    /// The time a candidate was judged over: the day it was listed; for a new
    /// pair the week that led up to it, since its bytes were added up over
    /// that week; and for the whole PC the day before as well, since its 24
    /// hours are the ones ending on that day. Read on one day only, a real
    /// 9.5 GB day showed 444 MB on the Mac.
    public static (DateTimeOffset Start, DateTimeOffset End) Window(OutboundCandidate candidate)
    {
        var day = candidate.At.ToUniversalTime();
        var start = candidate.Kind switch
        {
            OutboundCandidateKind.NewPair => day.AddSeconds(-(OutboundCandidateRules.NewPairWindow - 86_400)),
            OutboundCandidateKind.Machine => day.AddHours(-23),
            _ => day,
        };
        return (start, day.AddDays(1));
    }
}
