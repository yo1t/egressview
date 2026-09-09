using System.Net;
using System.Net.Http.Headers;

namespace EgressView.Agent.Core;

public sealed record AgentUninstallResult(bool HubRegistrationRevoked, bool ContinuedWithoutRevocation,
    bool LocalHistoryDeleted, long PendingQueueDeleted);

public sealed class AgentUninstallException(string reason, int? statusCode = null, Exception? inner = null)
    : Exception(reason, inner)
{
    public string Reason { get; } = reason;
    public int? StatusCode { get; } = statusCode;
}

/// <summary>Revokes the enrolled Windows Agent without following redirects or sending cookies.</summary>
public sealed class AgentUninstallClient : IDisposable
{
    private readonly HttpClient client;

    public AgentUninstallClient(HttpMessageHandler? handler = null)
    {
        handler ??= new HttpClientHandler
        {
            AllowAutoRedirect = false,
            UseCookies = false,
            AutomaticDecompression = DecompressionMethods.None,
        };
        client = new HttpClient(handler, disposeHandler: true) { Timeout = TimeSpan.FromSeconds(15) };
    }

    public async Task RevokeAsync(AgentCredential credential, CancellationToken cancellationToken = default)
    {
        if (!AgentEnrollmentClient.IsValidCredential(credential))
            throw new AgentUninstallException("invalid-credential");
        var endpoint = new Uri(credential.HubUrl.AbsoluteUri.TrimEnd('/') + "/api/agent/registration/revoke");
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential.Token);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        try
        {
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (response.StatusCode != HttpStatusCode.OK)
                throw new AgentUninstallException("hub-rejected", (int)response.StatusCode);
        }
        catch (AgentUninstallException) { throw; }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        { throw new AgentUninstallException("timeout"); }
        catch (HttpRequestException exception)
        { throw new AgentUninstallException("network-error", null, exception); }
    }

    public void Dispose() => client.Dispose();
}
