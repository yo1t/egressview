using System.Windows;
using System.ComponentModel;
using System.Text.Json;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

public partial class MainWindow : Window
{
    private readonly AgentEnrollmentClient enrollment = new();
    private readonly CancellationTokenSource lifetime = new();
    private bool loadingDeliveryState;

    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await RefreshStatusAsync();
        Closing += HideToTray;
        Closed += (_, _) => lifetime.Cancel();
    }

    private void HideToTray(object? sender, CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App { IsExiting: false })
        {
            e.Cancel = true;
            Hide();
        }
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RefreshStatusAsync();
    private async void SevenDays_Click(object sender, RoutedEventArgs e) => await SummaryAsync(7);
    private async void ThirtyDays_Click(object sender, RoutedEventArgs e) => await SummaryAsync(30);
    private async void Enroll_Click(object sender, RoutedEventArgs e)
    {
        if (!Uri.TryCreate(HubUrl.Text.Trim(), UriKind.Absolute, out var hubUrl))
        {
            EnrollmentStatus.Text = "Hub URLを確認してください / Check the Hub URL.";
            return;
        }
        EnrollButton.IsEnabled = false;
        HubUrl.IsEnabled = false;
        EnrollmentCode.IsEnabled = false;
        try
        {
            EnrollmentStatus.Text = "登録を申請しています / Requesting enrollment…";
            var metadata = new AgentEnrollmentMetadata(Environment.MachineName, "windows",
                Environment.OSVersion.VersionString, "0.1.0-dev");
            var ticket = await enrollment.ApplyAsync(hubUrl, EnrollmentCode.Password, metadata, lifetime.Token);
            EnrollmentCode.Clear();
            while (DateTimeOffset.UtcNow <= ticket.ExpiresAt)
            {
                EnrollmentStatus.Text = "Hub管理者の承認を待っています / Waiting for Hub administrator approval…";
                var claim = await enrollment.ClaimOnceAsync(ticket, lifetime.Token);
                if (claim.Status == EnrollmentClaimStatus.Pending)
                {
                    await Task.Delay(TimeSpan.FromSeconds(3), lifetime.Token);
                    continue;
                }
                if (claim.Status == EnrollmentClaimStatus.Rejected)
                    throw new AgentEnrollmentException("declined");
                if (claim.Status == EnrollmentClaimStatus.Expired || claim.Credential is null)
                    throw new AgentEnrollmentException("expired");
                var request = JsonSerializer.Serialize(new { v = 1, op = "save-enrollment", credential = claim.Credential });
                var response = await AgentIpcClient.RequestAsync(request, lifetime.Token);
                using var document = JsonDocument.Parse(response);
                if (document.RootElement.GetProperty("status").GetString() != "ok")
                    throw new AgentEnrollmentException(document.RootElement.TryGetProperty("reason", out var reason) ? reason.GetString() ?? "credential-storage-failed" : "credential-storage-failed");
                EnrollmentStatus.Text = "登録が完了しました。資格情報はServiceが安全に保存しました。\r\nEnrollment complete. The Service stored the credential securely.";
                return;
            }
            throw new AgentEnrollmentException("expired");
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        catch (AgentEnrollmentException exception) { EnrollmentStatus.Text = EnrollmentDiagnostic(exception); }
        catch (Exception exception)
        {
            EnrollmentStatus.Text = "登録に失敗しました。Hubへの接続を確認してください。\r\nEnrollment failed. Check the Hub connection."
                + $"\r\nDiagnostic: {exception.GetType().Name}";
        }
        finally
        {
            EnrollButton.IsEnabled = true;
            HubUrl.IsEnabled = true;
            EnrollmentCode.IsEnabled = true;
        }
    }

    private async void DeliveryEnabled_Click(object sender, RoutedEventArgs e)
    {
        if (loadingDeliveryState) return;
        var enabled = DeliveryEnabled.IsChecked == true;
        try
        {
            var response = await AgentIpcClient.RequestAsync(JsonSerializer.Serialize(new { v = 1, op = "set-delivery-enabled", enabled }), lifetime.Token);
            using var document = JsonDocument.Parse(response);
            if (document.RootElement.GetProperty("status").GetString() != "ok") throw new InvalidOperationException();
            EnrollmentStatus.Text = enabled
                ? "観測データのHub送信を開始しました / Hub observation delivery is on."
                : "観測データのHub送信を停止しました / Hub observation delivery is off.";
        }
        catch
        {
            loadingDeliveryState = true;
            DeliveryEnabled.IsChecked = !enabled;
            loadingDeliveryState = false;
            EnrollmentStatus.Text = "送信設定を変更できませんでした / Could not change delivery setting.";
        }
    }

    private async Task RefreshStatusAsync()
    {
        Output.Text = "読み込み中 / Loading…";
        try
        {
            var response = await AgentIpcClient.RequestAsync("""{"v":1,"op":"status"}""");
            Output.Text = IpcResponsePresenter.Present(response);
            using var document = JsonDocument.Parse(response);
            loadingDeliveryState = true;
            DeliveryEnabled.IsChecked = document.RootElement.GetProperty("data").GetProperty("deliveryEnabled").GetBoolean();
            loadingDeliveryState = false;
        }
        catch (Exception exception) { Output.Text = $"Agentに接続できません / Cannot connect to Agent\r\n{exception.Message}"; }
    }

    internal static string EnrollmentMessage(string reason) => reason switch
    {
        "invalid-hub-url" => "HTTPSのHub URLを入力してください。HTTPはこのPC内だけ使用できます。\r\nEnter an HTTPS Hub URL. HTTP is allowed only on this PC.",
        "invalid-enrollment-code" => "6文字の登録コードを確認してください。\r\nCheck the six-character enrollment code.",
        "plaintext-not-accepted" => "Hubが暗号化されていないAgent通信を許可していません。\r\nThe Hub does not accept unencrypted Agent traffic.",
        "declined" => "Hub管理者がこの申請を拒否しました。\r\nThe Hub administrator declined this request.",
        "expired" => "登録申請の有効期限が切れました。新しいコードでやり直してください。\r\nThe enrollment request expired. Try again with a new code.",
        "credential-storage-failed" => "資格情報をServiceへ保存できませんでした。Agent Serviceを確認してください。\r\nCould not store the credential. Check the Agent Service.",
        _ => "登録に失敗しました。コードとHubの状態を確認してください。\r\nEnrollment failed. Check the code and Hub status.",
    };
    internal static string EnrollmentDiagnostic(AgentEnrollmentException exception) => EnrollmentMessage(exception.Reason)
        + $"\r\nDiagnostic: {exception.Reason}{(exception.StatusCode is { } status ? $" (HTTP {status})" : string.Empty)}";
    private Task SummaryAsync(int days) => RequestAsync($"{{\"v\":1,\"op\":\"summary\",\"days\":{days}}}");
    private async Task RequestAsync(string request)
    {
        Output.Text = "読み込み中 / Loading…";
        try
        {
            var response = await AgentIpcClient.RequestAsync(request);
            Output.Text = IpcResponsePresenter.Present(response);
        }
        catch (Exception exception) { Output.Text = $"Agentに接続できません / Cannot connect to Agent\r\n{exception.Message}"; }
    }
}
