using System.Text.Json;

namespace EgressView.Agent.Core;

/// What the sharing remembers between runs, beside the database
/// (`outbound-candidate-sharing.json`). The two switches are the person's;
/// the rest is what the Hub was last told.
/// <param name="Enabled">"Send the worth-a-look list and answers to the Hub". Off by default.</param>
/// <param name="IncludesNotes">"Send the notes too". Off by default, and only read while Enabled.</param>
/// <param name="HubMayHoldList">Set once a list reached the Hub, cleared once
/// it was told to delete it. While set and sharing is off, the delete is owed.</param>
/// <param name="HubTakesAnswers">The Hub answers candidates itself, so it is
/// told <c>notesShared</c>.</param>
/// <param name="HubHasNotesShared">The last list it took said notes are shared.
/// Until it has, the Hub sends no notes, and an answer without one must not
/// wipe the note here.</param>
public sealed record OutboundCandidateSharingState(
    bool Enabled = false, bool IncludesNotes = false,
    string? LastSentHash = null, DateTimeOffset? LastSentAt = null, bool HubMayHoldList = false,
    bool HubTakesAnswers = false, bool HubHasNotesShared = false, int? HubMaximumEntries = null,
    int? AppliedAnswersVersion = null, string Status = "off", DateTimeOffset? StatusAt = null, int? StatusCode = null)
{
    public const string FileName = "outbound-candidate-sharing.json";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public static OutboundCandidateSharingState Read(string dataDirectory)
    {
        try { return JsonSerializer.Deserialize<OutboundCandidateSharingState>(File.ReadAllText(Path.Combine(dataDirectory, FileName)), Json) ?? new(); }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException) { return new(); }
    }

    public void Write(string dataDirectory)
    {
        var path = Path.Combine(dataDirectory, FileName);
        var temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(this, Json));
        File.Move(temporary, path, overwrite: true);
    }
}

/// Sends the "worth a look" list and the person's answers to the Hub when the
/// person turned that on (P3-194), and takes in the answers given on the Hub.
/// The Mac's `OutboundCandidateSharingController`, without the timer, which
/// the service owns.
///
/// Sent only when what the Hub would show has changed, or six hours have
/// passed. Turning it off sends one request that deletes the list from the
/// Hub, tried again on every run until the Hub has taken it. Only to a Hub
/// whose capabilities say <c>outboundCandidates: true</c>.
public sealed class OutboundCandidateSharer(ObservationStore store, string dataDirectory,
    Func<AgentCredential?> credential, OutboundCandidateHubClient client, TimeProvider? clock = null)
{
    private readonly SemaphoreSlim running = new(1, 1);
    private readonly object gate = new();
    private readonly TimeProvider time = clock ?? TimeProvider.System;
    private OutboundCandidateSharingState state = OutboundCandidateSharingState.Read(dataDirectory);
    private DateTimeOffset? takeInFailedAt;

    /// After a failed fetch, delivery replies (every few seconds) do not ask
    /// again for this long.
    private static readonly TimeSpan TakeInRetryInterval = TimeSpan.FromSeconds(60);

    public OutboundCandidateSharingState State { get { lock (gate) return state; } }

    private void Update(Func<OutboundCandidateSharingState, OutboundCandidateSharingState> change)
    {
        lock (gate)
        {
            state = change(state);
            try { state.Write(dataDirectory); } catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        }
    }

    /// The person's two switches. Turning sharing on sends at once; off owes
    /// the Hub a delete.
    public void SetSwitches(bool enabled, bool includesNotes) => Update(current => current with
    {
        Enabled = enabled, IncludesNotes = includesNotes,
        LastSentHash = enabled && !current.Enabled ? null : current.LastSentHash,
        Status = enabled ? (current.Enabled ? current.Status : "waiting") : (current.HubMayHoldList ? "removing" : "off"),
    });

    /// What a delivery reply said about the Hub's answers: null from a Hub
    /// that does not answer candidates. A changed version is taken in.
    public async Task HubAnswersVersionAsync(int? version, CancellationToken cancellationToken)
    {
        NoteHubTakesAnswers(version is not null);
        var current = State;
        if (version is null || !current.Enabled || version == current.AppliedAnswersVersion) return;
        if (takeInFailedAt is { } failed && time.GetUtcNow() - failed < TakeInRetryInterval) return;
        await TakeInAnswersAsync(cancellationToken);
    }

    /// A Hub that starts or stops answering is sent the list again, with or
    /// without <c>notesShared</c>.
    private void NoteHubTakesAnswers(bool value)
    {
        if (State.HubTakesAnswers == value) return;
        Update(current => current with
        {
            HubTakesAnswers = value, HubHasNotesShared = value && current.HubHasNotesShared, LastSentHash = null,
        });
    }

    /// The hourly run and every change: take in the Hub's answers, then send
    /// if anything is owed.
    /// A run asked for while one is going runs once more afterwards, so the
    /// last change is never left unsent.
    public async Task RunAsync(CancellationToken cancellationToken)
    {
        if (!await running.WaitAsync(0, cancellationToken)) { again = true; return; }
        try
        {
            do
            {
                again = false;
                if (State.Enabled) await TakeInAnswersAsync(cancellationToken);
                await SendAsync(cancellationToken);
            }
            while (again && !cancellationToken.IsCancellationRequested);
        }
        finally { running.Release(); }
    }

    private volatile bool again;

    private async Task TakeInAnswersAsync(CancellationToken cancellationToken)
    {
        if (credential() is not { } enrolled || !OutboundCandidateHubClient.IsAllowed(enrolled.HubUrl)) return;
        var answers = await client.AnswersAsync(enrolled, cancellationToken);
        if (answers is null) { takeInFailedAt = time.GetUtcNow(); return; }
        takeInFailedAt = null;
        if (answers.Version < 0) { NoteHubTakesAnswers(false); return; }
        NoteHubTakesAnswers(true);
        var current = State;
        var changed = store.ApplyHubOutboundCandidateAnswers(answers.Answers, current.HubHasNotesShared && current.IncludesNotes, time.GetUtcNow());
        // A change here is sent back with the list, so the Hub sees this PC has it.
        Update(value => value with { AppliedAnswersVersion = answers.Version, LastSentHash = changed > 0 ? null : value.LastSentHash });
    }

    private async Task SendAsync(CancellationToken cancellationToken)
    {
        var current = State;
        if (!current.Enabled && !current.HubMayHoldList)
        {
            if (current.Status != "off") Update(value => value with { Status = "off", StatusCode = null });
            return;
        }
        if (credential() is not { } enrolled)
        {
            Update(value => value with { Status = value.Enabled ? "not-enrolled" : "off" });
            return;
        }
        if (!OutboundCandidateHubClient.IsAllowed(enrolled.HubUrl))
        {
            Update(value => value with { Status = "insecure-url", StatusAt = time.GetUtcNow() });
            return;
        }
        var now = time.GetUtcNow();
        System.Text.Json.Nodes.JsonObject? payload = null;
        string? hash = null;
        if (current.Enabled)
        {
            var capabilities = await client.CapabilitiesAsync(enrolled, cancellationToken);
            if (capabilities.Takes == false)
            {
                Update(value => value with { Status = "hub-too-old", StatusAt = now, StatusCode = null });
                return;
            }
            if (capabilities.Takes == true)
            {
                Update(value => value with { HubMaximumEntries = capabilities.MaximumEntries });
                if (capabilities.TakesAnswers != current.HubTakesAnswers) NoteHubTakesAnswers(capabilities.TakesAnswers);
            }
            current = State;
            var report = store.ReadOutboundCandidates(now);
            var judgments = report.Judgments.ToDictionary(judgment => judgment.CandidateId, StringComparer.Ordinal);
            payload = OutboundCandidateSharePayload.Build(report, judgments, current.IncludesNotes, current.HubTakesAnswers,
                OutboundCandidateSharePayload.EntryLimit(current.HubMaximumEntries), now);
            hash = OutboundCandidateSharePayload.ContentHash(payload);
        }
        var plan = OutboundCandidateSharePlanner.Decide(current.Enabled, current.HubMayHoldList, current.LastSentHash, current.LastSentAt, hash, now);
        if (plan == OutboundCandidateSharePlan.Nothing)
        {
            if (current.Enabled && current.LastSentAt is { } at) Update(value => value with { Status = "sent", StatusAt = at, StatusCode = null });
            return;
        }
        var body = plan == OutboundCandidateSharePlan.SendList ? payload! : OutboundCandidateSharePayload.Off(now);
        var (outcome, code) = await client.SendAsync(enrolled, body, cancellationToken);
        switch (outcome)
        {
            case OutboundCandidateShareOutcome.Sent when plan == OutboundCandidateSharePlan.SendList:
                Update(value => value with
                {
                    LastSentHash = hash, LastSentAt = now, HubMayHoldList = true,
                    HubHasNotesShared = body["notesShared"]?.GetValue<bool>() == true,
                    Status = "sent", StatusAt = now, StatusCode = null,
                });
                break;
            case OutboundCandidateShareOutcome.Sent:
                Update(value => value with
                {
                    HubMayHoldList = false, HubHasNotesShared = false, AppliedAnswersVersion = null, LastSentHash = null, LastSentAt = null,
                    Status = "removed", StatusAt = now, StatusCode = null,
                });
                break;
            case OutboundCandidateShareOutcome.HubTooOld:
                // Nothing reached it, so nothing is held there.
                Update(value => value with { HubMayHoldList = value.Enabled && value.HubMayHoldList, Status = "hub-too-old", StatusAt = now, StatusCode = 404 });
                break;
            default:
                Update(value => value with { Status = "failed", StatusAt = now, StatusCode = code });
                break;
        }
    }
}
