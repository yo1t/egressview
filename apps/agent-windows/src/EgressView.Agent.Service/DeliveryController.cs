using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class DeliveryController : IDisposable
{
    private readonly ObservationStore store;
    private readonly WindowsCredentialStore credentials;
    private readonly DeliverySender sender;
    private readonly SemaphoreSlim wake = new(0, 1);
    private readonly SemaphoreSlim sendGate = new(1, 1);
    private readonly object stateGate = new();
    private DeliveryRuntimeStatus status = new("idle");

    internal DeliveryController(ObservationStore store, WindowsCredentialStore credentials, DeliverySender? sender = null)
    {
        this.store = store;
        this.credentials = credentials;
        this.sender = sender ?? new DeliverySender();
    }

    internal DeliveryRuntimeStatus Status { get { lock (stateGate) return status; } }
    internal DeliveryCapabilityStatus CapabilityStatus => sender.CapabilityStatus;

    internal void RequestNow()
    {
        if (!store.DeliveryEnabled || credentials.Load() is null)
            throw new InvalidOperationException("Delivery must be enabled and enrolled before sending.");
        try { wake.Release(); } catch (SemaphoreFullException) { }
    }

    internal void SettingsChanged()
    {
        try { wake.Release(); } catch (SemaphoreFullException) { }
    }

    internal void PauseAndWait()
    {
        store.DeliveryEnabled = false;
        SettingsChanged();
        sendGate.Wait();
        sendGate.Release();
        SetState("disabled", null);
    }

    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        var retry = TimeSpan.FromSeconds(5);
        while (!cancellationToken.IsCancellationRequested)
        {
            var delay = TimeSpan.FromSeconds(15);
            try
            {
                if (!store.DeliveryEnabled)
                    SetState("disabled", null);
                else if (credentials.Load() is not { } credential)
                    SetState("not-enrolled", null);
                else
                {
                    await sendGate.WaitAsync(cancellationToken);
                    DeliveryAttempt result;
                    var attemptedAt = DateTimeOffset.UtcNow;
                    try
                    {
                        if (!store.DeliveryEnabled) { SetState("disabled", null); continue; }
                        SetState("sending", null, attemptedAt);
                        result = await sender.SendNextAsync(store, credential,
                            new(Environment.MachineName, "windows", Environment.OSVersion.VersionString, "0.1.0-dev"), cancellationToken);
                    }
                    finally { sendGate.Release(); }
                    delay = result.Kind switch
                    {
                        DeliveryAttemptKind.Acknowledged => TimeSpan.Zero,
                        DeliveryAttemptKind.Empty => TimeSpan.FromSeconds(15),
                        DeliveryAttemptKind.RateLimited => result.RetryAfter ?? TimeSpan.FromMinutes(1),
                        DeliveryAttemptKind.AuthorizationRequired => TimeSpan.FromMinutes(5),
                        DeliveryAttemptKind.Incompatible => TimeSpan.FromHours(1),
                        _ => retry,
                    };
                    var state = State(result.Kind);
                    SetState(state, delay > TimeSpan.Zero ? DateTimeOffset.UtcNow + delay : null, attemptedAt,
                        IsFailure(result.Kind) ? state : null, result.StatusCode);
                    retry = result.Kind is DeliveryAttemptKind.Retryable or DeliveryAttemptKind.Rejected or DeliveryAttemptKind.InvalidAcknowledgement
                        ? TimeSpan.FromSeconds(Math.Min(retry.TotalSeconds * 2, 300)) : TimeSpan.FromSeconds(5);
                }
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
            catch
            {
                delay = retry;
                SetState("retryable", DateTimeOffset.UtcNow + delay, DateTimeOffset.UtcNow, "retryable");
                retry = TimeSpan.FromSeconds(Math.Min(retry.TotalSeconds * 2, 300));
            }

            if (delay <= TimeSpan.Zero) continue;
            try { await wake.WaitAsync(delay, cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { break; }
        }
    }

    private void SetState(string state, DateTimeOffset? nextRetryAt, DateTimeOffset? lastAttemptAt = null,
        string? failure = null, int? statusCode = null)
    {
        lock (stateGate)
        {
            status = new(state, lastAttemptAt ?? status.LastAttemptAt, nextRetryAt,
                failure ?? status.LastFailure, failure is null ? status.LastFailureAt : DateTimeOffset.UtcNow,
                failure is null ? status.LastStatusCode : statusCode);
        }
    }

    private static string State(DeliveryAttemptKind kind) => kind switch
    {
        DeliveryAttemptKind.Empty => "up-to-date",
        DeliveryAttemptKind.Acknowledged => "acknowledged",
        DeliveryAttemptKind.AuthorizationRequired => "authorization-required",
        DeliveryAttemptKind.RateLimited => "rate-limited",
        DeliveryAttemptKind.Retryable => "retryable",
        DeliveryAttemptKind.Rejected => "contract-rejected",
        DeliveryAttemptKind.InvalidAcknowledgement => "invalid-acknowledgement",
        DeliveryAttemptKind.Incompatible => "hub-incompatible",
        _ => "retryable",
    };

    private static bool IsFailure(DeliveryAttemptKind kind) => kind is not DeliveryAttemptKind.Empty and not DeliveryAttemptKind.Acknowledged;

    public void Dispose() { wake.Dispose(); sendGate.Dispose(); }
}
