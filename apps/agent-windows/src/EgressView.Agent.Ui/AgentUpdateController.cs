using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Reflection;
using System.Security.Cryptography;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

internal enum UpdateStateKind { Idle, Checking, UpToDate, Downloading, Verified, Failed, Launching }

internal sealed record UpdateState(UpdateStateKind Kind, string CurrentVersion, string? AvailableVersion = null,
    string? Publisher = null, string? Detail = null, DateTimeOffset? CheckedAt = null);

internal sealed class AgentUpdateController : IDisposable
{
    private readonly WindowsAgentUpdateClient client;
    private readonly SemaphoreSlim gate = new(1, 1);
    private VerifiedAgentUpdate? verified;

    internal AgentUpdateController(WindowsAgentUpdateClient? client = null)
    {
        this.client = client ?? new WindowsAgentUpdateClient();
        State = new(UpdateStateKind.Idle, CurrentVersion, CheckedAt: AgentSettings.LastUpdateCheck);
    }

    internal string CurrentVersion => Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0.0.0";
    internal UpdateState State { get; private set; }
    internal bool CanInstall => State.Kind == UpdateStateKind.Verified && verified is not null;
    internal event EventHandler? StateChanged;

    internal Task RunIfDueAsync(CancellationToken cancellationToken = default) =>
        AgentSettings.AutomaticUpdateChecks && (AgentSettings.LastUpdateCheck is not { } last || DateTimeOffset.UtcNow - last >= TimeSpan.FromHours(24))
            ? CheckNowAsync(cancellationToken) : Task.CompletedTask;

    internal async Task CheckNowAsync(CancellationToken cancellationToken = default)
    {
        if (!await gate.WaitAsync(0, cancellationToken)) return;
        try
        {
            Set(new(UpdateStateKind.Checking, CurrentVersion, CheckedAt: AgentSettings.LastUpdateCheck));
            var checkedAt = DateTimeOffset.UtcNow;
            AgentSettings.LastUpdateCheck = checkedAt;
            var decision = await client.CheckAsync(CurrentVersion, Environment.OSVersion.Version.ToString(), cancellationToken);
            if (decision.Kind == AgentUpdateDecisionKind.UpToDate)
            {
                verified = null;
                Set(new(UpdateStateKind.UpToDate, CurrentVersion, decision.PublishedVersion, CheckedAt: checkedAt));
                return;
            }

            Set(new(UpdateStateKind.Downloading, CurrentVersion, decision.PublishedVersion, CheckedAt: checkedAt));
            var downloadDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "EgressView", "Agent", "Updates");
            verified = await client.DownloadAndVerifyAsync(decision.Candidate!, downloadDirectory, cancellationToken);
            Set(new(UpdateStateKind.Verified, CurrentVersion, verified.Version, verified.Publisher,
                $"SHA-256 {verified.Sha256[..12]}… · {verified.SizeBytes / 1024d / 1024d:N1} MiB", checkedAt));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
        catch (Exception exception)
        {
            verified = null;
            Set(new(UpdateStateKind.Failed, CurrentVersion, Detail: Classify(exception), CheckedAt: AgentSettings.LastUpdateCheck));
        }
        finally { gate.Release(); }
    }

    internal async Task<bool> LaunchInstallerAsync(CancellationToken cancellationToken = default)
    {
        if (verified is null) return false;
        if (!await gate.WaitAsync(0, cancellationToken)) return false;
        try
        {
            Set(State with { Kind = UpdateStateKind.Launching });
            await client.ReverifyAsync(verified, cancellationToken);
            StartRelaunchWatcher(verified.Version);
            Process.Start(new ProcessStartInfo("msiexec.exe", $"/i \"{verified.Path}\"") { UseShellExecute = true, Verb = "runas" });
            return true;
        }
        catch (Exception exception)
        {
            Set(State with { Kind = UpdateStateKind.Failed, Detail = Classify(exception) });
            return false;
        }
        finally { gate.Release(); }
    }

    private void Set(UpdateState value) { State = value; StateChanged?.Invoke(this, EventArgs.Empty); }

    private static void StartRelaunchWatcher(string expectedVersion)
    {
        var uiPath = Environment.ProcessPath ?? throw new InvalidOperationException("The UI executable path is unavailable.");
        var encoded = UpdateRelaunchCommand.BuildEncodedPowerShell(Environment.ProcessId, uiPath, expectedVersion, TimeSpan.FromMinutes(15));
        var start = new ProcessStartInfo("powershell.exe")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        start.ArgumentList.Add("-NoProfile");
        start.ArgumentList.Add("-NonInteractive");
        start.ArgumentList.Add("-WindowStyle");
        start.ArgumentList.Add("Hidden");
        start.ArgumentList.Add("-EncodedCommand");
        start.ArgumentList.Add(encoded);
        _ = Process.Start(start) ?? throw new InvalidOperationException("The update relaunch watcher could not start.");
    }

    private static string Classify(Exception exception) => exception switch
    {
        CryptographicException => "verification-failed",
        HttpRequestException => "network-error",
        InvalidDataException => "release-invalid",
        _ => "update-error",
    };

    public void Dispose() { client.Dispose(); gate.Dispose(); }
}
