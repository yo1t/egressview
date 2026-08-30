using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace EgressView.Agent.Core;

public sealed record AgentEnrollmentMetadata(string HostName, string Platform, string OsVersion, string AgentVersion);
public sealed record AgentEnrollmentTicket(Uri HubUrl, Guid RequestId, string ClaimSecret, DateTimeOffset ExpiresAt)
{
    public override string ToString() => $"AgentEnrollmentTicket {{ HubUrl = {HubUrl}, RequestId = {RequestId}, ClaimSecret = <redacted>, ExpiresAt = {ExpiresAt:O} }}";
}
public sealed record AgentCredential(Uri HubUrl, Guid AgentId, string Token, DateTimeOffset EnrolledAt)
{
    public override string ToString() => $"AgentCredential {{ HubUrl = {HubUrl}, AgentId = {AgentId}, Token = <redacted>, EnrolledAt = {EnrolledAt:O} }}";
}

public enum EnrollmentClaimStatus { Pending, Approved, Rejected, Expired }
public sealed record EnrollmentClaim(EnrollmentClaimStatus Status, AgentCredential? Credential = null);

public sealed class AgentEnrollmentException(string reason, int? statusCode = null) : Exception(reason)
{
    public string Reason { get; } = reason;
    public int? StatusCode { get; } = statusCode;
}

public sealed partial class AgentEnrollmentClient(HttpClient http)
{
    public AgentEnrollmentClient() : this(new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false })
    {
        Timeout = TimeSpan.FromSeconds(15),
    }) { }

    public async Task<AgentEnrollmentTicket> ApplyAsync(
        Uri hubUrl, string code, AgentEnrollmentMetadata metadata, CancellationToken cancellationToken = default)
    {
        if (!IsAllowedHubUrl(hubUrl)) throw new AgentEnrollmentException("invalid-hub-url");
        var normalized = code.Trim().ToUpperInvariant();
        if (!EnrollmentCode().IsMatch(normalized)) throw new AgentEnrollmentException("invalid-enrollment-code");
        ValidateMetadata(metadata);

        using var response = await http.PostAsJsonAsync(
            Endpoint(hubUrl, "api/agent/enrollment-requests"),
            new { code = normalized, agent = metadata }, cancellationToken);
        if (response.StatusCode == HttpStatusCode.BadRequest)
            throw new AgentEnrollmentException("plaintext-not-accepted", (int)response.StatusCode);
        if (response.StatusCode != HttpStatusCode.Accepted)
            throw new AgentEnrollmentException("enrollment-rejected", (int)response.StatusCode);
        var payload = await response.Content.ReadFromJsonAsync<ApplyResponse>(cancellationToken: cancellationToken)
            ?? throw new AgentEnrollmentException("invalid-response");
        if (payload.RequestId == Guid.Empty || !ClaimSecret().IsMatch(payload.ClaimSecret) || payload.ExpiresAt <= 0)
            throw new AgentEnrollmentException("invalid-response");
        return new(hubUrl, payload.RequestId, payload.ClaimSecret, DateTimeOffset.FromUnixTimeMilliseconds(payload.ExpiresAt));
    }

    public async Task<EnrollmentClaim> ClaimOnceAsync(AgentEnrollmentTicket ticket, CancellationToken cancellationToken = default)
    {
        if (!IsAllowedHubUrl(ticket.HubUrl) || ticket.RequestId == Guid.Empty || !ClaimSecret().IsMatch(ticket.ClaimSecret))
            throw new AgentEnrollmentException("invalid-ticket");
        using var response = await http.PostAsJsonAsync(
            Endpoint(ticket.HubUrl, "api/agent/enrollment-requests/claim"),
            new { requestId = ticket.RequestId, claimSecret = ticket.ClaimSecret }, cancellationToken);
        var payload = await response.Content.ReadFromJsonAsync<ClaimResponse>(cancellationToken: cancellationToken)
            ?? throw new AgentEnrollmentException("invalid-response");
        return payload.Status switch
        {
            "pending" when response.IsSuccessStatusCode => new(EnrollmentClaimStatus.Pending),
            "rejected" when response.IsSuccessStatusCode => new(EnrollmentClaimStatus.Rejected),
            "expired" or "unknown" or "collected" => new(EnrollmentClaimStatus.Expired),
            "approved" when response.StatusCode == HttpStatusCode.Created && payload.AgentId is { } id && id != Guid.Empty
                && payload.Token is { } token && AgentToken().IsMatch(token)
                => new(EnrollmentClaimStatus.Approved, new AgentCredential(ticket.HubUrl, id, token, DateTimeOffset.UtcNow)),
            _ => throw new AgentEnrollmentException("invalid-response", (int)response.StatusCode),
        };
    }

    public static bool IsAllowedHubUrl(Uri url) => url.IsAbsoluteUri
        && string.IsNullOrEmpty(url.UserInfo) && string.IsNullOrEmpty(url.Query) && string.IsNullOrEmpty(url.Fragment)
        && (url.Scheme == Uri.UriSchemeHttps || (url.Scheme == Uri.UriSchemeHttp && url.IsLoopback));

    public static bool IsValidCredential(AgentCredential credential) => IsAllowedHubUrl(credential.HubUrl)
        && credential.AgentId != Guid.Empty && AgentToken().IsMatch(credential.Token);

    private static Uri Endpoint(Uri hubUrl, string relative) => new(hubUrl.AbsoluteUri.TrimEnd('/') + "/" + relative);
    private static void ValidateMetadata(AgentEnrollmentMetadata value)
    {
        if (value.Platform != "windows" || !Safe(value.HostName, 255) || !Safe(value.OsVersion, 64) || !Safe(value.AgentVersion, 64))
            throw new AgentEnrollmentException("invalid-metadata");
    }
    private static bool Safe(string value, int max) => value.Length is > 0 && value.Length <= max && !value.Any(char.IsControl);

    [GeneratedRegex("^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$", RegexOptions.CultureInvariant)] private static partial Regex EnrollmentCode();
    [GeneratedRegex("^egvc_[0-9a-f]{64}$", RegexOptions.CultureInvariant)] private static partial Regex ClaimSecret();
    [GeneratedRegex("^egva_[0-9a-f]{64}$", RegexOptions.CultureInvariant)] private static partial Regex AgentToken();

    private sealed record ApplyResponse(Guid RequestId, string ClaimSecret, long ExpiresAt);
    private sealed record ClaimResponse(string Status, string? Token, Guid? AgentId);
}
