using System.Windows;
using System.ComponentModel;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        Loaded += async (_, _) => await RequestAsync("""{"v":1,"op":"status"}""");
        Closing += HideToTray;
    }

    private void HideToTray(object? sender, CancelEventArgs e)
    {
        if (System.Windows.Application.Current is App { IsExiting: false })
        {
            e.Cancel = true;
            Hide();
        }
    }
    private async void Refresh_Click(object sender, RoutedEventArgs e) => await RequestAsync("""{"v":1,"op":"status"}""");
    private async void SevenDays_Click(object sender, RoutedEventArgs e) => await SummaryAsync(7);
    private async void ThirtyDays_Click(object sender, RoutedEventArgs e) => await SummaryAsync(30);
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
