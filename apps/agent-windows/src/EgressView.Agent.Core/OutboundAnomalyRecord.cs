using System.Text.Json;

namespace EgressView.Agent.Core;

/// One application or destination and what it sent in an anomalous window.
public sealed record OutboundContributor(string Name, ulong BytesOut);

/// What explains an anomaly: the usual level it was compared with, and who
/// sent the most.
///
/// Written when the anomaly is found, because that is the only time it can
/// be: the usual level is not kept anywhere else, and the window's
/// observations age out of the store. Same content as the Mac Agent's
/// breakdown (P3-180), so the two describe the same laptop the same way.
public sealed record OutboundAnomalyBreakdown(
    ulong UsualBytesOut,
    IReadOnlyList<OutboundContributor> Applications,
    IReadOnlyList<OutboundContributor> Destinations,
    int SendingDestinationCount)
{
    /// The most applications and destinations kept, each.
    public const int ContributorLimit = 5;

    public string ToJson() => JsonSerializer.Serialize(this);

    /// Null for anything that does not read back, rather than a breakdown
    /// that says nobody sent anything.
    public static OutboundAnomalyBreakdown? FromJson(string? json)
    {
        if (string.IsNullOrEmpty(json)) return null;
        try { return JsonSerializer.Deserialize<OutboundAnomalyBreakdown>(json); }
        catch (JsonException) { return null; }
    }
}

/// A window the detector flagged, with whatever was kept about it.
/// <see cref="Breakdown"/> is null for windows flagged before 0.1.140, which
/// began keeping it, and the screen says so rather than showing nothing.
public sealed record OutboundAnomalyRecord(
    OutboundAnomalyKind Kind,
    DateTimeOffset WindowStart,
    ulong BytesOut,
    int ApplicationCount,
    int DestinationCount,
    OutboundAnomalyBreakdown? Breakdown)
{
    public static readonly TimeSpan WindowLength = TimeSpan.FromMinutes(15);

    public DateTimeOffset WindowEnd => WindowStart + WindowLength;

    public static string KindName(OutboundAnomalyKind kind) =>
        kind == OutboundAnomalyKind.DistributedTransfer ? "distributed-transfer" : "large-transfer";

    public static OutboundAnomalyKind ParseKind(string? name) =>
        name == "distributed-transfer" ? OutboundAnomalyKind.DistributedTransfer : OutboundAnomalyKind.LargeTransfer;
}
