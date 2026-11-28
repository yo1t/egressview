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

    /// The connections behind a listed candidate, or null when no candidate
    /// listed now has the id.
    public OutboundCandidateEvidence? ReadOutboundCandidateEvidence(string candidateId, DateTimeOffset now)
    {
        OutboundCandidate? candidate;
        lock (gate) candidate = ReadOutboundCandidatesLocked(now).Candidates.FirstOrDefault(item => item.Id == candidateId);
        return candidate is null ? null : ReadOutboundCandidateEvidence(candidate);
    }

    /// The connections behind a candidate, from the raw history.
    ///
    /// Read an hour at a time, as the baseline is written, so a week of a
    /// busy PC does not hold the lock against the collector for long. Keyed
    /// exactly as <see cref="CaptureBaselineHourLocked"/> keys them, a nameless
    /// row taking the one domain its application reached at that address in
    /// the hour, so what is shown adds up to what was judged as far as the raw
    /// history still reaches.
    public OutboundCandidateEvidence ReadOutboundCandidateEvidence(OutboundCandidate candidate, int limit = OutboundCandidateEvidence.FlowLimit)
    {
        var (start, end) = OutboundCandidateEvidence.Window(candidate);
        // Not past what the baseline has read: the candidate was judged on
        // those hours, and the rest of today has not happened yet. Taking the
        // whole of today, a candidate listed at lunchtime read as 17%
        // monitored and "more may have been sent" (2026-11-28).
        string? through;
        lock (gate) through = NullableScalarText("SELECT captured_through FROM baseline_state WHERE id=1");
        if (through is not null && DateTimeOffset.Parse(through, CultureInfo.InvariantCulture) is var captured && captured < end && captured > start)
            end = captured;
        var flows = new Dictionary<(string Application, string? Hostname, string Address), OutboundEvidenceFlow>();
        for (var hour = start; hour < end; hour = hour.AddHours(1))
        {
            var next = hour.AddHours(1) < end ? hour.AddHours(1) : end;
            var rows = new List<(string Address, string? Hostname, string Application, ulong Sent, long Connections, long First, long Last)>();
            lock (gate)
            {
                ThrowIfDisposed();
                CheckOperation(WinSqlite.Prepare(db, "SELECT o.remote_address,COALESCE(o.remote_hostname,f.remote_hostname),COALESCE(o.process_name,''),COUNT(*)," +
                    "COALESCE(SUM(o.bytes_sent),0),MIN(o.observed_at),MAX(o.observed_at) FROM observations o LEFT JOIN flows f ON f.rowid=o.flow_id " +
                    $"WHERE o.observed_at >= {hour.UtcTicks} AND o.observed_at < {next.UtcTicks} GROUP BY 1,2,3", -1, out var statement, 0));
                try
                {
                    while (WinSqlite.Step(statement) == WinSqlite.Row)
                    {
                        var address = Text(statement, 0);
                        if (PrivateAddress.StaysOnNetwork(address)) continue;
                        rows.Add((address, NullableTextValue(statement, 1), OutboundBaselineKeys.Application(Text(statement, 2)),
                            (ulong)Math.Max(0, WinSqlite.ColumnInt64(statement, 4)), WinSqlite.ColumnInt64(statement, 3),
                            WinSqlite.ColumnInt64(statement, 5), WinSqlite.ColumnInt64(statement, 6)));
                    }
                }
                finally { WinSqlite.Finalize(statement); }
            }
            // The same rule as OutboundBaselineKeys.Pairs.
            var domains = new Dictionary<(string Address, string Application), string?>();
            foreach (var row in rows)
            {
                if (string.IsNullOrWhiteSpace(row.Hostname)) continue;
                var domain = OutboundBaselineKeys.Destination(row.Hostname, row.Address);
                var key = (row.Address, row.Application);
                domains[key] = !domains.TryGetValue(key, out var held) || held == domain ? domain : null;
            }
            foreach (var row in rows)
            {
                var hostname = string.IsNullOrWhiteSpace(row.Hostname) ? domains.GetValueOrDefault((row.Address, row.Application)) : row.Hostname;
                if (candidate.Application is { } wanted && candidate.Destination is { } destination
                    && (row.Application != wanted || OutboundBaselineKeys.Destination(hostname, row.Address) != destination)) continue;
                var first = new DateTimeOffset(row.First, TimeSpan.Zero);
                var last = new DateTimeOffset(row.Last, TimeSpan.Zero);
                var flowKey = (row.Application, hostname, row.Address);
                flows[flowKey] = flows.TryGetValue(flowKey, out var held)
                    ? held with
                    {
                        BytesOut = unchecked(held.BytesOut + row.Sent), Connections = held.Connections + row.Connections,
                        FirstAt = first < held.FirstAt ? first : held.FirstAt, LastAt = last > held.LastAt ? last : held.LastAt,
                    }
                    : new(row.Application, hostname, row.Address, row.Sent, row.Connections, first, last);
            }
        }

        lock (gate)
        {
            var from = start.ToString("O", CultureInfo.InvariantCulture);
            var to = end.ToString("O", CultureInfo.InvariantCulture);
            long monitored = 0, observations = 0, withBytes = 0;
            CheckOperation(WinSqlite.Prepare(db, "SELECT COALESCE(SUM(monitored_seconds),0),COALESCE(SUM(observations),0),COALESCE(SUM(observations_with_bytes),0) " +
                $"FROM baseline_hours WHERE hour_start>='{from}' AND hour_start<'{to}'", -1, out var statement, 0));
            try
            {
                if (WinSqlite.Step(statement) == WinSqlite.Row)
                {
                    monitored = WinSqlite.ColumnInt64(statement, 0);
                    observations = WinSqlite.ColumnInt64(statement, 1);
                    withBytes = WinSqlite.ColumnInt64(statement, 2);
                }
            }
            finally { WinSqlite.Finalize(statement); }
            var oldestRaw = NullableScalarText("SELECT CAST(MIN(observed_at) AS TEXT) FROM observations");
            var partial = oldestRaw is null || long.Parse(oldestRaw, CultureInfo.InvariantCulture) > start.UtcTicks;
            var sorted = flows.Values.OrderByDescending(flow => flow.BytesOut)
                .ThenBy(flow => $"{flow.Application}|{flow.Hostname}|{flow.Address}", StringComparer.Ordinal).ToList();
            return new(start, end, sorted.Take(Math.Max(0, limit)).ToList(), sorted.Count,
                sorted.Aggregate(0UL, (sum, flow) => unchecked(sum + flow.BytesOut)),
                Math.Min(monitored, (long)(end - start).TotalSeconds),
                observations == 0 ? null : (double)withBytes / observations, partial);
        }
    }

    /// Takes in the answers given on the Hub (P3-194 stage 2), as the Mac's
    /// <c>applyHubOutboundCandidateAnswers</c> does.
    ///
    /// An answer is matched to a candidate by the hash this PC sent for it,
    /// and replaces this PC's answer only when it was given later: whoever
    /// answered last wins, on either side. A Hub answer of null takes this
    /// PC's older answer back. The note follows the Hub's only when notes are
    /// shared (<paramref name="takesNotes"/>); otherwise the Hub never had this
    /// PC's note and sends none, so the note here is kept. The Hub's time is
    /// rounded up to the whole second, because the time sent back is in whole
    /// seconds: kept as it is, it would read as older than the Hub's answer
    /// and the Hub would keep its own copy for good.
    /// <returns>How many answers changed here.</returns>
    public int ApplyHubOutboundCandidateAnswers(IReadOnlyList<OutboundCandidateHubAnswer> answers, bool takesNotes, DateTimeOffset now)
    {
        if (answers.Count == 0) return 0;
        lock (gate)
        {
            var byHash = ReadOutboundCandidatesLocked(now).Candidates
                .ToDictionary(candidate => OutboundCandidateSharePayload.HashedId(candidate.Id), StringComparer.Ordinal);
            var current = ReadOutboundCandidateJudgmentsLocked();
            var changed = 0;
            Execute("BEGIN IMMEDIATE");
            try
            {
                foreach (var answer in answers)
                {
                    if (!byHash.TryGetValue(answer.CandidateId, out var candidate)) continue;
                    var ticks = answer.AnsweredAt.UtcTicks;
                    var at = new DateTimeOffset(ticks + (TimeSpan.TicksPerSecond - ticks % TimeSpan.TicksPerSecond) % TimeSpan.TicksPerSecond, TimeSpan.Zero);
                    var local = current.GetValueOrDefault(candidate.Id);
                    if (local is not null && local.JudgedAt >= at) continue;
                    if (OutboundCandidateJudgment.Parse(answer.Answer) is not { } verdict)
                    {
                        if (local is null) continue;
                        CheckOperation(WinSqlite.Prepare(db, "DELETE FROM outbound_candidate_judgments WHERE candidate_id=?", -1, out var remove, 0));
                        try { Bind(remove, 1, candidate.Id); CheckDone(WinSqlite.Step(remove)); }
                        finally { WinSqlite.Finalize(remove); }
                        changed++;
                        continue;
                    }
                    var note = takesNotes ? (answer.Note ?? "") : (local?.Note ?? "");
                    CheckOperation(WinSqlite.Prepare(db,
                        "INSERT OR REPLACE INTO outbound_candidate_judgments(candidate_id,candidate_at,application,destination,verdict,note,judged_at,answered_on) VALUES(?,?,?,?,?,?,?,'hub')",
                        -1, out var statement, 0));
                    try
                    {
                        Bind(statement, 1, candidate.Id);
                        Bind(statement, 2, candidate.At.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture));
                        BindNullable(statement, 3, candidate.Application);
                        BindNullable(statement, 4, candidate.Destination);
                        Bind(statement, 5, OutboundCandidateJudgment.Code(verdict));
                        Bind(statement, 6, OutboundCandidateJudgment.Clip(note));
                        Bind(statement, 7, at.ToString("O", CultureInfo.InvariantCulture));
                        CheckDone(WinSqlite.Step(statement));
                    }
                    finally { WinSqlite.Finalize(statement); }
                    changed++;
                }
                Execute("COMMIT");
            }
            catch { TryRollback(); throw; }
            return changed;
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
