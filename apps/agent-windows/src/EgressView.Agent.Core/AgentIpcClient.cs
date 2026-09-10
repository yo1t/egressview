using System.IO.Pipes;
using System.Text;

namespace EgressView.Agent.Core;

public static class AgentIpcClient
{
    public const string PipeName = "egressview-agent-v1";
    public static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);

    public static async Task<string> RequestAsync(string request, CancellationToken cancellationToken = default,
        TimeSpan? timeout = null)
    {
        using var requestTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        requestTimeout.CancelAfter(timeout ?? RequestTimeout);
        await using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await client.ConnectAsync(5_000, requestTimeout.Token);
            await using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, true);
            await writer.WriteLineAsync(request.AsMemory(), requestTimeout.Token);
            return await reader.ReadLineAsync(requestTimeout.Token) ?? throw new IOException("Agent closed the IPC connection without a response.");
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested && requestTimeout.IsCancellationRequested)
        {
            throw new TimeoutException("The Agent IPC request did not complete before the response timeout.", exception);
        }
    }
}
