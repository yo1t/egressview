namespace EgressView.Agent.Core;

/// What the person decided about one candidate (P3-194 phase 1), as on the
/// Mac (`OutboundCandidateTriage.swift`).
///
/// Two answers, not three. A candidate states that this PC sent more than
/// usual, which is a fact and so cannot be "a false positive"; what the person
/// can say is whether it matters to them.
public enum OutboundCandidateVerdict
{
    /// The person recognises it: their own upload, sync or update.
    Expected,
    /// The person wants to look further.
    Investigate,
}

/// Kept apart from the candidate, which is worked out from the baseline every
/// time and is never changed by an answer.
///
/// Stays on this PC. Not written to the diagnostics report or a notification:
/// a note can name people and places.
/// <param name="AnsweredOnHub">Given on the Hub and taken in from it, rather
/// than answered on this PC. Always false until sharing comes.</param>
public sealed record OutboundCandidateJudgment(
    string CandidateId,
    DateTimeOffset CandidateAt,
    OutboundCandidateVerdict Verdict,
    string Note,
    DateTimeOffset JudgedAt,
    bool AnsweredOnHub = false)
{
    /// A note is a reminder, not a document.
    public const int NoteLimit = 500;

    public static string Code(OutboundCandidateVerdict verdict) =>
        verdict == OutboundCandidateVerdict.Expected ? "expected" : "investigate";

    public static OutboundCandidateVerdict? Parse(string? code) => code switch
    {
        "expected" => OutboundCandidateVerdict.Expected,
        "investigate" => OutboundCandidateVerdict.Investigate,
        _ => null,
    };

    /// Trimmed and cut to <see cref="NoteLimit"/> characters, counted as the
    /// person sees them rather than in UTF-16 units, so an emoji is not split.
    public static string Clip(string? note)
    {
        var trimmed = (note ?? "").Trim();
        var info = new System.Globalization.StringInfo(trimmed);
        return info.LengthInTextElements <= NoteLimit ? trimmed : info.SubstringByTextElements(0, NoteLimit);
    }
}
