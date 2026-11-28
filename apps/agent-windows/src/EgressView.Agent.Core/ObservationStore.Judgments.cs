using System.Globalization;

namespace EgressView.Agent.Core;

/// The person's answers to the "worth a look" candidates (P3-194 phase 1).
public sealed partial class ObservationStore
{
    /// Version 36: answers, apart from the candidates, which are worked out
    /// every time and never stored. The same columns as the Mac's
    /// `outbound_candidate_judgments`, `answered_on` included, so taking in
    /// the Hub's answers later needs no second migration. Times are ISO 8601
    /// in UTC, as everywhere else in this database.
    private const string Version36Schema = """
        CREATE TABLE IF NOT EXISTS outbound_candidate_judgments(
          candidate_id TEXT PRIMARY KEY,
          candidate_at TEXT NOT NULL,
          application TEXT,
          destination TEXT,
          verdict TEXT NOT NULL CHECK(verdict IN ('expected','investigate')),
          note TEXT NOT NULL DEFAULT '',
          judged_at TEXT NOT NULL,
          answered_on TEXT CHECK(answered_on IS NULL OR answered_on='hub')
        ) WITHOUT ROWID;
        CREATE INDEX IF NOT EXISTS outbound_candidate_judgments_at ON outbound_candidate_judgments(candidate_at);
        CREATE INDEX IF NOT EXISTS outbound_candidate_judgments_pair ON outbound_candidate_judgments(application,destination,judged_at);
        """;

    /// No backup: one new table, empty, in one transaction.
    private void MigrateVersion35To36()
    {
        try
        {
            Execute("BEGIN IMMEDIATE; " + Version36Schema + " UPDATE schema_version SET version=36 WHERE version=35; COMMIT;");
        }
        catch { TryRollback(); throw; }
    }

    public IReadOnlyDictionary<string, OutboundCandidateJudgment> ReadOutboundCandidateJudgments()
    {
        lock (gate) return ReadOutboundCandidateJudgmentsLocked();
    }

    private Dictionary<string, OutboundCandidateJudgment> ReadOutboundCandidateJudgmentsLocked()
    {
        var result = new Dictionary<string, OutboundCandidateJudgment>(StringComparer.Ordinal);
        CheckOperation(WinSqlite.Prepare(db,
            "SELECT candidate_id,candidate_at,verdict,note,judged_at,answered_on FROM outbound_candidate_judgments", -1, out var statement, 0));
        try
        {
            while (WinSqlite.Step(statement) == WinSqlite.Row)
            {
                if (OutboundCandidateJudgment.Parse(Text(statement, 2)) is not { } verdict) continue;
                var id = Text(statement, 0);
                result[id] = new(id, Time(Text(statement, 1)), verdict, Text(statement, 3), Time(Text(statement, 4)),
                    NullableTextValue(statement, 5) == "hub");
            }
        }
        finally { WinSqlite.Finalize(statement); }
        return result;

        static DateTimeOffset Time(string text) => DateTimeOffset.Parse(text, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal);
    }

    /// Records the answer, replacing any earlier one. A null verdict takes it
    /// back.
    public void SetOutboundCandidateJudgment(OutboundCandidate candidate, OutboundCandidateVerdict? verdict, string? note, DateTimeOffset now)
    {
        lock (gate)
        {
            if (verdict is not { } given)
            {
                CheckOperation(WinSqlite.Prepare(db, "DELETE FROM outbound_candidate_judgments WHERE candidate_id=?", -1, out var remove, 0));
                try { Bind(remove, 1, candidate.Id); CheckDone(WinSqlite.Step(remove)); }
                finally { WinSqlite.Finalize(remove); }
                return;
            }
            CheckOperation(WinSqlite.Prepare(db,
                "INSERT OR REPLACE INTO outbound_candidate_judgments(candidate_id,candidate_at,application,destination,verdict,note,judged_at) VALUES(?,?,?,?,?,?,?)",
                -1, out var statement, 0));
            try
            {
                Bind(statement, 1, candidate.Id);
                Bind(statement, 2, candidate.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                BindNullable(statement, 3, candidate.Application);
                BindNullable(statement, 4, candidate.Destination);
                Bind(statement, 5, OutboundCandidateJudgment.Code(given));
                Bind(statement, 6, OutboundCandidateJudgment.Clip(note));
                Bind(statement, 7, now.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                CheckDone(WinSqlite.Step(statement));
            }
            finally { WinSqlite.Finalize(statement); }
        }
    }

    /// For the window, which names a candidate by its id. A null note keeps
    /// the one already there, so answering without opening the note does not
    /// wipe it. False when no candidate listed now has the id.
    public bool SetOutboundCandidateJudgment(string candidateId, OutboundCandidateVerdict? verdict, string? note, DateTimeOffset now)
    {
        lock (gate)
        {
            var candidate = ReadOutboundCandidatesLocked(now).Candidates.FirstOrDefault(item => item.Id == candidateId);
            if (candidate is null) return false;
            note ??= ReadOutboundCandidateJudgmentsLocked().GetValueOrDefault(candidateId)?.Note;
            SetOutboundCandidateJudgment(candidate, verdict, note, now);
            return true;
        }
    }

    /// Settings > History: "Delete all answers".
    public void RemoveAllOutboundCandidateJudgments()
    {
        lock (gate) Execute("DELETE FROM outbound_candidate_judgments");
    }

    /// A judgment outlives its candidate in the list by
    /// <see cref="OutboundCandidateRules.JudgmentRetention"/>, and never the
    /// history it is about.
    private void PruneJudgmentsLocked(DateTimeOffset historyCutoff)
    {
        var listed = DateTimeOffset.UtcNow.AddSeconds(-(OutboundCandidateRules.ListWindow + OutboundCandidateRules.JudgmentRetention));
        var cutoff = (historyCutoff > listed ? historyCutoff : listed).ToUniversalTime().ToString("O", CultureInfo.InvariantCulture);
        Execute($"DELETE FROM outbound_candidate_judgments WHERE candidate_at<'{cutoff}'");
    }

    /// A judgment is about traffic in the deleted time, so it goes with it.
    private void DeleteJudgmentsLocked(DateTimeOffset? before)
    {
        if (before is not { } cutoff) { Execute("DELETE FROM outbound_candidate_judgments"); return; }
        Execute($"DELETE FROM outbound_candidate_judgments WHERE candidate_at<'{cutoff.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)}'");
    }
}
