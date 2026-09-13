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
        // Every await here resumes on the thread pool rather than on whatever
        // context called in. A library that captures its caller's context
        // deadlocks the moment someone blocks on it, and the UI thread is
        // exactly where that happens: the continuation needs the dispatcher,
        // the dispatcher is waiting for the continuation, and neither the
        // timeout nor the cancellation can run to break it. Nothing in this
        // method touches UI state, so there is nothing to resume onto.
        await using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        try
        {
            await client.ConnectAsync(5_000, requestTimeout.Token).ConfigureAwait(false);
            await using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
            using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, true);
            await writer.WriteLineAsync(request.AsMemory(), requestTimeout.Token).ConfigureAwait(false);
            return await reader.ReadLineAsync(requestTimeout.Token).ConfigureAwait(false) ?? throw new IOException("Agent closed the IPC connection without a response.");
        }
        catch (OperationCanceledException exception) when (!cancellationToken.IsCancellationRequested && requestTimeout.IsCancellationRequested)
        {
            throw new TimeoutException("The Agent IPC request did not complete before the response timeout.", exception);
        }
    }
}
