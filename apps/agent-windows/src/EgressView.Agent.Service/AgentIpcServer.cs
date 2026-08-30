using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using EgressView.Agent.Core;

namespace EgressView.Agent.Service;

internal sealed class AgentIpcServer(ObservationStore store, Func<CollectorSnapshot> snapshot, string allowedSid) : IAsyncDisposable
{
    public const string PipeName = "egressview-agent-v1";
    private readonly CancellationTokenSource stop = new();
    private Task? loop;

    public void Start() => loop = Task.Run(ServeAsync);

    internal static PipeSecurity BuildSecurity(string allowedSid)
    {
        var security = new PipeSecurity();
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.NetworkSid, null), PipeAccessRights.FullControl, AccessControlType.Deny));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null), PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(new SecurityIdentifier(allowedSid), PipeAccessRights.ReadWrite | PipeAccessRights.Synchronize, AccessControlType.Allow));
        return security;
    }

    private async Task ServeAsync()
    {
        while (!stop.IsCancellationRequested)
        {
            await using var pipe = NamedPipeServerStreamAcl.Create(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous, 4096, 4096, BuildSecurity(allowedSid));
            try { await pipe.WaitForConnectionAsync(stop.Token); }
            catch (OperationCanceledException) when (stop.IsCancellationRequested) { break; }
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 4096, true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            var line = await reader.ReadLineAsync(stop.Token);
            if (line is not null) await writer.WriteLineAsync(IpcProtocol.Handle(line, Status, Summary));
        }
    }

    private string Status() => DiagnosticsReport.Create(snapshot(), store, "0.1.0-dev");
    private IReadOnlyList<HourlySummary> Summary(int days) => store.ReadHourlySummary(DateTimeOffset.UtcNow.AddDays(-days), DateTimeOffset.UtcNow);

    public async ValueTask DisposeAsync()
    {
        stop.Cancel();
        if (loop is not null) try { await loop; } catch (OperationCanceledException) { }
        stop.Dispose();
    }
}
