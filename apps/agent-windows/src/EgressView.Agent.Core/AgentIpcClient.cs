using System.IO.Pipes;
using System.Text;

namespace EgressView.Agent.Core;

public static class AgentIpcClient
{
    public const string PipeName = "egressview-agent-v1";

    public static async Task<string> RequestAsync(string request, CancellationToken cancellationToken = default)
    {
        await using var client = new NamedPipeClientStream(".", PipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        await client.ConnectAsync(5_000, cancellationToken);
        await using var writer = new StreamWriter(client, new UTF8Encoding(false), 4096, true) { AutoFlush = true };
        using var reader = new StreamReader(client, Encoding.UTF8, false, 4096, true);
        await writer.WriteLineAsync(request.AsMemory(), cancellationToken);
        return await reader.ReadLineAsync(cancellationToken) ?? throw new IOException("Agent closed the IPC connection without a response.");
    }
}
