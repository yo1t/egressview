using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace EgressView.Agent.Core;

public sealed record DeliveryMetadata(string HostName, string Platform, string OsVersion, string AgentVersion);
public enum DeliveryAttemptKind { Empty, Acknowledged, AuthorizationRequired, RateLimited, Retryable, Rejected, InvalidAcknowledgement }
public sealed record DeliveryAttempt(DeliveryAttemptKind Kind, TimeSpan? RetryAfter = null, int? StatusCode = null);

public sealed class DeliverySender
{
    private readonly HttpClient http;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public DeliverySender(HttpClient? http = null)
    {
        this.http = http ?? new HttpClient(new SocketsHttpHandler { AllowAutoRedirect = false })
        {
            Timeout = TimeSpan.FromSeconds(20),
        };
    }

    public async Task<DeliveryAttempt> SendNextAsync(ObservationStore store, AgentCredential credential,
        DeliveryMetadata metadata, CancellationToken cancellationToken = default)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential)) return new(DeliveryAttemptKind.AuthorizationRequired);
        var batch = store.PrepareDeliveryBatch(DateTimeOffset.UtcNow);
        if (batch is null) return new(DeliveryAttemptKind.Empty);
        var envelope = new DeliveryEnvelope(1, batch.BatchId, Timestamp(batch.SentAt), metadata,
            batch.Observations.Select(item => new DeliveryPayload(
                item.ObservationId, item.NetworkProtocol, item.LocalAddress, item.LocalPort, item.RemoteAddress,
                item.RemotePort, item.ProcessId, item.ProcessName, item.BundleID, Timestamp(item.FirstObservedAt),
                Timestamp(item.LastObservedAt), item.BytesIn?.ToString(), item.BytesOut?.ToString(), item.Collector, item.Confidence)).ToArray());
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
            if (acknowledgement is null || acknowledgement.BatchId != batch.BatchId || acknowledgement.Rejected != 0
                || acknowledgement.Accepted + acknowledgement.Duplicate != batch.Observations.Count)
                return new(DeliveryAttemptKind.InvalidAcknowledgement);
            store.AcknowledgeDelivery(batch.BatchId, DateTimeOffset.UtcNow);
            return new(DeliveryAttemptKind.Acknowledged);
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
        string? BytesIn, string? BytesOut, string Collector, string Confidence);
    private sealed record AgentIngestAcknowledgement(Guid BatchId, int Accepted, int Duplicate, int Rejected, bool Replayed);
}
