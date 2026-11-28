using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

/// Runs <see cref="OutboundCandidateSharer"/> every hour, and at once when
/// the person answers a candidate or changes a switch (P3-194).
internal sealed class OutboundSharingController(ObservationStore store, string dataDirectory, WindowsCredentialStore credentials)
    : IDisposable
{
    private static readonly TimeSpan CheckInterval = TimeSpan.FromHours(1);
    private readonly SemaphoreSlim wake = new(0, 1);
    private CancellationToken stopping;

    internal OutboundCandidateSharer Sharer { get; } =
        new(store, dataDirectory, credentials.Load, OutboundCandidateHubClient.Create());

    /// Something the Hub would show may have changed.
    internal void Changed()
    {
        try { wake.Release(); } catch (SemaphoreFullException) { }
    }

    internal void SetSwitches(bool enabled, bool includesNotes)
    {
        Sharer.SetSwitches(enabled, includesNotes);
        Changed();
    }

    /// From each delivery acknowledgement; quick unless the Hub's answers changed.
    internal void HubAnswersVersion(int? version) =>
        _ = Task.Run(async () =>
        {
            var before = Sharer.State.AppliedAnswersVersion;
            try { await Sharer.HubAnswersVersionAsync(version, stopping); } catch { }
            // Answers taken in go back with the list, so the Hub sees this PC has them.
            if (Sharer.State.AppliedAnswersVersion != before) Changed();
        });

    internal async Task RunAsync(CancellationToken cancellationToken)
    {
        stopping = cancellationToken;
        while (!cancellationToken.IsCancellationRequested)
        {
            try { await Sharer.RunAsync(cancellationToken); }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            catch (Exception) { /* Tried again within the hour. */ }
            try { await wake.WaitAsync(CheckInterval, cancellationToken); }
            catch (OperationCanceledException) { return; }
        }
    }

    public void Dispose() => wake.Dispose();
}
