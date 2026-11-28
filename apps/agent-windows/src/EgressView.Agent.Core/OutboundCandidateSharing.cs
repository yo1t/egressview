using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace EgressView.Agent.Core;

/// What goes to <c>PUT /api/agent/outbound-candidates</c> (P3-194), as on
/// the Mac (`OutboundCandidateSharing.swift`, #906): the candidate named by a
/// SHA-256 of its id, and a note only when the person turned on the second
/// switch. Held to `protocol/agent-outbound-candidates/v1/golden.json`.
public static class OutboundCandidateSharePayload
{
    /// What every Hub takes, and all a Hub that does not name
    /// <c>maxOutboundCandidates</c> takes: it refuses a longer list whole.
    public const int LegacyEntryLimit = 20;

    /// The most sent even to a Hub that would take more, which keeps the body
    /// under the Hub's 512 KiB with the longest names and notes.
    public const int MaximumEntryLimit = 150;

    public static int EntryLimit(int? hubMaximum) =>
        hubMaximum is { } maximum && maximum > LegacyEntryLimit ? Math.Min(maximum, MaximumEntryLimit) : LegacyEntryLimit;

    /// The list as it stands, cut at <paramref name="entryLimit"/>
    /// (<c>total</c> still counts them all). Keys sorted and times in whole
    /// seconds, as the Mac's encoder writes them.
    public static JsonObject Build(OutboundCandidateReport report, IReadOnlyDictionary<string, OutboundCandidateJudgment> judgments,
        bool includesNotes, bool hubTakesAnswers, int entryLimit, DateTimeOffset generatedAt)
    {
        var entries = new JsonArray();
        foreach (var candidate in report.Candidates.Take(Math.Max(0, entryLimit)))
        {
            var judgment = judgments.GetValueOrDefault(candidate.Id);
            var note = includesNotes ? (judgment?.Note ?? "").Trim() : "";
            var entry = new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal)
            {
                ["candidateId"] = HashedId(candidate.Id),
                ["kind"] = OutboundCandidateRules.KindCode(candidate.Kind),
                ["day"] = Time(candidate.At),
                ["bytesOut"] = candidate.BytesOut,
            };
            if (candidate.Application is { } application) entry["application"] = Clip(application, AiInsightContextBuilder.NameCharacterLimit);
            if (candidate.Destination is { } destination) entry["destination"] = Clip(destination, AiInsightContextBuilder.NameCharacterLimit);
            if (candidate.UsualBytesOut is { } usual) entry["usualBytesOut"] = usual;
            if (judgment is not null)
            {
                entry["answer"] = OutboundCandidateJudgment.Code(judgment.Verdict);
                entry["answeredAt"] = Time(judgment.JudgedAt);
                if (note.Length > 0) entry["note"] = Clip(note, OutboundCandidateJudgment.NoteLimit);
            }
            entries.Add(new JsonObject(entry));
        }
        var body = new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal)
        {
            ["schemaVersion"] = 1,
            ["sharing"] = true,
            ["generatedAt"] = Time(generatedAt),
            ["state"] = report.State switch
            {
                OutboundCandidateState.Learning => "learning",
                OutboundCandidateState.LowByteCoverage => "lowByteCoverage",
                _ => "ready",
            },
            ["total"] = report.Total,
            ["entries"] = entries,
        };
        // Only a Hub that answers candidates is told; an older one refuses a
        // field it does not know.
        if (hubTakesAnswers) body["notesShared"] = includesNotes;
        return new JsonObject(body);
    }

    /// Tells the Hub to delete what it holds for this PC.
    public static JsonObject Off(DateTimeOffset generatedAt) => new(new SortedDictionary<string, JsonNode?>(StringComparer.Ordinal)
    {
        ["entries"] = new JsonArray(),
        ["generatedAt"] = Time(generatedAt),
        ["schemaVersion"] = 1,
        ["sharing"] = false,
        ["total"] = 0,
    });

    /// Changes when anything the Hub would show changes; not when only the
    /// time of sending does.
    public static string ContentHash(JsonObject payload)
    {
        var stable = (JsonObject)payload.DeepClone();
        stable["generatedAt"] = Time(DateTimeOffset.UnixEpoch);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(stable.ToJsonString()))).ToLowerInvariant();
    }

    public static string HashedId(string id) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id))).ToLowerInvariant();

    /// The Hub counts length in UTF-16 units, as JavaScript does. Cut on a
    /// whole character within that count.
    public static string Clip(string text, int limit)
    {
        if (text.Length <= limit) return text;
        var result = new StringBuilder();
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            var element = (string)elements.Current;
            if (result.Length + element.Length > limit) break;
            result.Append(element);
        }
        return result.ToString();
    }

    private static string Time(DateTimeOffset value) => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}

public enum OutboundCandidateSharePlan { Nothing, SendList, SendOff }

public static class OutboundCandidateSharePlanner
{
    /// Sent again after this long even without a change, so the Hub's
    /// "received" time says the PC is still sharing.
    public static readonly TimeSpan ResendInterval = TimeSpan.FromHours(6);

    public static OutboundCandidateSharePlan Decide(bool enabled, bool hubMayHoldList, string? lastSentHash, DateTimeOffset? lastSentAt,
        string? currentHash, DateTimeOffset now)
    {
        if (!enabled) return hubMayHoldList ? OutboundCandidateSharePlan.SendOff : OutboundCandidateSharePlan.Nothing;
        if (currentHash is null) return OutboundCandidateSharePlan.Nothing;
        if (currentHash != lastSentHash || lastSentAt is not { } sent) return OutboundCandidateSharePlan.SendList;
        return now - sent >= ResendInterval ? OutboundCandidateSharePlan.SendList : OutboundCandidateSharePlan.Nothing;
    }
}

/// One answer given on the Hub (P3-194 stage 2), as
/// <c>GET /api/agent/outbound-candidates/answers</c> lists it.
/// <param name="CandidateId">The hash this PC sent for the candidate.</param>
/// <param name="Answer">expected, investigate, or null when taken back on the Hub.</param>
/// <param name="Note">Only when this PC shares notes.</param>
public sealed record OutboundCandidateHubAnswer(string CandidateId, string? Answer, string? Note, DateTimeOffset AnsweredAt);

public sealed record OutboundCandidateHubAnswers(int Version, IReadOnlyList<OutboundCandidateHubAnswer> Answers)
{
    public static OutboundCandidateHubAnswers Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        var answers = new List<OutboundCandidateHubAnswer>();
        foreach (var item in root.GetProperty("answers").EnumerateArray())
            answers.Add(new(item.GetProperty("candidateId").GetString() ?? "",
                item.TryGetProperty("answer", out var answer) && answer.ValueKind == JsonValueKind.String ? answer.GetString() : null,
                item.TryGetProperty("note", out var note) && note.ValueKind == JsonValueKind.String ? note.GetString() : null,
                DateTimeOffset.Parse(item.GetProperty("answeredAt").GetString()!, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal)));
        return new(root.GetProperty("version").GetInt32(), answers);
    }
}

public enum OutboundCandidateShareOutcome { Sent, HubTooOld, Failed }

/// <param name="Takes">Whether the Hub's capabilities say it takes the list.
/// Null when it could not be asked.</param>
public sealed record OutboundCandidateHubCapabilities(bool? Takes, bool TakesAnswers, int? MaximumEntries);

/// Talks to the Hub this PC is enrolled with. HTTPS only, as for threat
/// information, except to this PC itself.
public sealed class OutboundCandidateHubClient(HttpClient http)
{
    /// No redirects, no cookies, and the Agent's own User-Agent, as for delivery.
    public static OutboundCandidateHubClient Create()
    {
        var http = new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false, UseCookies = false }) { Timeout = TimeSpan.FromSeconds(60) };
        AgentEnrollmentClient.EnsureUserAgent(http);
        return new(http);
    }

    public static bool IsAllowed(Uri hub) => hub.Scheme == Uri.UriSchemeHttps || hub.IsLoopback;

    private static Uri At(AgentCredential credential, string path) => new(credential.HubUrl.ToString().TrimEnd('/') + path);

    private static HttpRequestMessage Request(HttpMethod method, AgentCredential credential, string path)
    {
        var request = new HttpRequestMessage(method, At(credential, path));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        return request;
    }

    /// Whether the Hub takes the list and how long a one: a Hub with no
    /// capabilities (404) is older than this, and one that answers without
    /// <c>outboundCandidates: true</c> does not take it.
    public async Task<OutboundCandidateHubCapabilities> CapabilitiesAsync(AgentCredential credential, CancellationToken cancellationToken)
    {
        try
        {
            using var request = Request(HttpMethod.Get, credential, "/api/agent/capabilities");
            using var response = await http.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.NotFound) return new(false, false, null);
            if (response.StatusCode != HttpStatusCode.OK) return new(null, false, null);
            using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
            var root = document.RootElement;
            bool Flag(string name) => root.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.True;
            int? maximum = root.TryGetProperty("maxOutboundCandidates", out var max) && max.TryGetInt32(out var parsed) ? parsed : null;
            return new(Flag("outboundCandidates"), Flag("outboundCandidateAnswers"), maximum);
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            return new(null, false, null);
        }
    }

    public async Task<(OutboundCandidateShareOutcome Outcome, int? StatusCode)> SendAsync(AgentCredential credential, JsonObject payload,
        CancellationToken cancellationToken)
    {
        try
        {
            using var request = Request(HttpMethod.Put, credential, "/api/agent/outbound-candidates");
            request.Content = new StringContent(payload.ToJsonString(), Encoding.UTF8, "application/json");
            using var response = await http.SendAsync(request, cancellationToken);
            return response.StatusCode switch
            {
                HttpStatusCode.OK => (OutboundCandidateShareOutcome.Sent, 200),
                HttpStatusCode.NotFound => (OutboundCandidateShareOutcome.HubTooOld, 404),
                var code => (OutboundCandidateShareOutcome.Failed, (int)code),
            };
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            return (OutboundCandidateShareOutcome.Failed, null);
        }
    }

    /// Null when the Hub could not be asked; an empty list with version -1
    /// when it is too old to answer candidates.
    public async Task<OutboundCandidateHubAnswers?> AnswersAsync(AgentCredential credential, CancellationToken cancellationToken)
    {
        try
        {
            using var request = Request(HttpMethod.Get, credential, "/api/agent/outbound-candidates/answers");
            using var response = await http.SendAsync(request, cancellationToken);
            if (response.StatusCode == HttpStatusCode.NotFound) return new(-1, []);
            if (response.StatusCode != HttpStatusCode.OK) return null;
            return OutboundCandidateHubAnswers.Parse(await response.Content.ReadAsStringAsync(cancellationToken));
        }
        catch (Exception exception) when (exception is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            return null;
        }
    }
}
