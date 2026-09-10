using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EgressView.Agent.Core;

public sealed record DeliveryMetadata(string HostName, string Platform, string OsVersion, string AgentVersion);
public enum DeliveryAttemptKind { Empty, Acknowledged, AuthorizationRequired, RateLimited, Retryable, Rejected, InvalidAcknowledgement, Incompatible }
public sealed record DeliveryAttempt(DeliveryAttemptKind Kind, TimeSpan? RetryAfter = null, int? StatusCode = null);
public sealed record DeliveryRuntimeStatus(string State, DateTimeOffset? LastAttemptAt = null,
    DateTimeOffset? NextRetryAt = null, string? LastFailure = null, DateTimeOffset? LastFailureAt = null,
    int? LastStatusCode = null);

public sealed class DeliverySender
{
    private readonly HttpClient http;
    private readonly TimeProvider timeProvider;
    private readonly object capabilityGate = new();
    private AgentHubCapabilities? capabilities;
    private string? capabilityHub;
    private DateTimeOffset? capabilityCheckedAt;
    private DeliveryCapabilityStatus capabilityStatus = new("not-checked");
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly TimeSpan CapabilitySuccessRefresh = TimeSpan.FromHours(24);
    private static readonly TimeSpan CapabilityRetry = TimeSpan.FromHours(1);

    public DeliverySender(HttpClient? http = null, TimeProvider? timeProvider = null)
    {
        this.http = http ?? new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
        this.timeProvider = timeProvider ?? TimeProvider.System;
        AgentEnrollmentClient.EnsureUserAgent(this.http);
    }

    public DeliveryCapabilityStatus CapabilityStatus { get { lock (capabilityGate) return capabilityStatus; } }

    public async Task<DeliveryAttempt> SendNextAsync(ObservationStore store, AgentCredential credential,
        DeliveryMetadata metadata, CancellationToken cancellationToken = default)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential)) return new(DeliveryAttemptKind.AuthorizationRequired);
        var outcome = await NegotiateAsync(credential, cancellationToken);
        if (outcome.Kind == AgentCapabilityOutcomeKind.Incompatible)
            return new(DeliveryAttemptKind.Incompatible);
        var batch = store.PrepareDeliveryBatch(timeProvider.GetUtcNow(), outcome.BatchSize);
        if (batch is null) return new(DeliveryAttemptKind.Empty);
        var envelope = new DeliveryEnvelope(outcome.SchemaVersion, batch.BatchId, Timestamp(batch.SentAt), metadata,
            batch.Observations.Select(item => new DeliveryPayload(
                item.ObservationId, item.NetworkProtocol, item.LocalAddress, item.LocalPort, item.RemoteAddress,
                item.RemotePort, item.ProcessId, item.ProcessName, item.BundleID, Timestamp(item.FirstObservedAt),
                Timestamp(item.LastObservedAt), item.BytesIn?.ToString(), item.BytesOut?.ToString(), item.Collector, item.Confidence,
                outcome.IncludeRemoteHostname ? item.RemoteHostname : null)).ToArray());
        using var request = new HttpRequestMessage(HttpMethod.Post,
            new Uri(credential.HubUrl.AbsoluteUri.TrimEnd('/') + "/api/agent/ingest"))
        {
            Content = JsonContent.Create(envelope, options: Json),
        };
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        HttpResponseMessage response;
        try { response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken); }
        catch (HttpRequestException) { return new(DeliveryAttemptKind.Retryable); }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested) { return new(DeliveryAttemptKind.Retryable); }
        using (response)
        {
            var status = (int)response.StatusCode;
            if (response.StatusCode is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
                return new(DeliveryAttemptKind.AuthorizationRequired, StatusCode: status);
            if (response.StatusCode == HttpStatusCode.TooManyRequests)
                return new(DeliveryAttemptKind.RateLimited, ParseRetryAfter(response), status);
            if (status >= 500) return new(DeliveryAttemptKind.Retryable, StatusCode: status);
            if (response.StatusCode != HttpStatusCode.OK) return new(DeliveryAttemptKind.Rejected, StatusCode: status);
            AgentIngestAcknowledgement? acknowledgement;
            try { acknowledgement = await response.Content.ReadFromJsonAsync<AgentIngestAcknowledgement>(Json, cancellationToken); }
            catch (JsonException) { return new(DeliveryAttemptKind.InvalidAcknowledgement); }
            if (acknowledgement is null || acknowledgement.BatchId != batch.BatchId
                || acknowledgement.Accepted < 0 || acknowledgement.Duplicate < 0 || acknowledgement.Rejected < 0
                || (long)acknowledgement.Accepted + acknowledgement.Duplicate + acknowledgement.Rejected != batch.Observations.Count)
                return new(DeliveryAttemptKind.InvalidAcknowledgement);
            if (acknowledgement.Rejected != 0)
                return new(DeliveryAttemptKind.Rejected);
            store.AcknowledgeDelivery(batch.BatchId, timeProvider.GetUtcNow());
            return new(DeliveryAttemptKind.Acknowledged);
        }
    }

    private async Task<AgentCapabilityOutcome> NegotiateAsync(AgentCredential credential, CancellationToken cancellationToken)
    {
        var hub = credential.HubUrl.AbsoluteUri.TrimEnd('/');
        var now = timeProvider.GetUtcNow();
        lock (capabilityGate)
        {
            if (!string.Equals(capabilityHub, hub, StringComparison.Ordinal))
            {
                capabilityHub = hub;
                capabilities = null;
                capabilityCheckedAt = null;
                capabilityStatus = new("not-checked");
            }
            if (capabilityCheckedAt is { } checkedAt)
            {
                var refresh = capabilities is null || capabilityStatus.State == "incompatible"
                    ? CapabilityRetry : CapabilitySuccessRefresh;
                if (now - checkedAt < refresh) return AgentCapabilityNegotiation.Decide(capabilities);
            }
            // Record the attempt before awaiting so concurrent callers cannot
            // turn a temporary outage into a request storm.
            capabilityCheckedAt = now;
        }

        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(hub + "/api/agent/capabilities"));
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        try
        {
            using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            var statusCode = (int)response.StatusCode;
            if (response.StatusCode != HttpStatusCode.OK)
            {
                SetCapabilities(null, new("unavailable", now, statusCode, Failure: $"http-{statusCode}"));
                return AgentCapabilityNegotiation.Decide(null);
            }
            AgentHubCapabilities? decoded;
            try { decoded = await response.Content.ReadFromJsonAsync<AgentHubCapabilities>(Json, cancellationToken); }
            catch (JsonException)
            {
                SetCapabilities(null, new("unavailable", now, statusCode, Failure: "invalid-response"));
                return AgentCapabilityNegotiation.Decide(null);
            }
            if (decoded is null)
            {
                SetCapabilities(null, new("unavailable", now, statusCode, Failure: "empty-response"));
                return AgentCapabilityNegotiation.Decide(null);
            }
            var outcome = AgentCapabilityNegotiation.Decide(decoded);
            SetCapabilities(decoded, new(outcome.Kind == AgentCapabilityOutcomeKind.Incompatible ? "incompatible" : "agreed",
                now, statusCode, outcome.SchemaVersion, outcome.BatchSize, outcome.IncludeRemoteHostname,
                outcome.Kind == AgentCapabilityOutcomeKind.Incompatible ? "no-common-schema" : null));
            return outcome;
        }
        catch (HttpRequestException)
        {
            SetCapabilities(null, new("unavailable", now, Failure: "request-failed"));
            return AgentCapabilityNegotiation.Decide(null);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            SetCapabilities(null, new("unavailable", now, Failure: "request-timeout"));
            return AgentCapabilityNegotiation.Decide(null);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            SetCapabilities(null, new("unavailable", now, Failure: "request-failed"));
            return AgentCapabilityNegotiation.Decide(null);
        }
    }

    private void SetCapabilities(AgentHubCapabilities? value, DeliveryCapabilityStatus status)
    {
        lock (capabilityGate)
        {
            capabilities = value;
            capabilityStatus = status;
        }
    }

    private static TimeSpan? ParseRetryAfter(HttpResponseMessage response)
    {
        if (response.Headers.RetryAfter?.Delta is { } delta) return delta;
        if (response.Headers.RetryAfter?.Date is { } date) return date - DateTimeOffset.UtcNow is { } value && value > TimeSpan.Zero ? value : TimeSpan.Zero;
        return null;
    }
    private static string Timestamp(DateTimeOffset value) => value.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'");

    private sealed record DeliveryEnvelope(int SchemaVersion, Guid BatchId, string SentAt, DeliveryMetadata Agent,
        IReadOnlyList<DeliveryPayload> Observations);
    private sealed record DeliveryPayload(Guid ObservationId, string NetworkProtocol, string LocalAddress, int LocalPort,
        string RemoteAddress, int RemotePort, [property: JsonPropertyName("processID")] int ProcessId, string ProcessName,
        [property: JsonPropertyName("bundleID")] string? BundleId, string FirstObservedAt, string LastObservedAt,
        string? BytesIn, string? BytesOut, string Collector, string Confidence,
        [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] string? RemoteHostname);
    private sealed record AgentIngestAcknowledgement(Guid BatchId, int Accepted, int Duplicate, int Rejected, bool Replayed);
}
