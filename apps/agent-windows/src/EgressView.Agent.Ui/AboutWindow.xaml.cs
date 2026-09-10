using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows;

namespace EgressView.Agent.Ui;

public partial class AboutWindow : Window
{
    private readonly string copyText;

    internal AboutWindow(AgentBuildIdentity ui, AgentBuildIdentity? service)
    {
        InitializeComponent();
        UiVersion.Text = ui.Version;
        UiBuild.Text = ui.Detail;
        ServiceVersion.Text = service?.Version ?? LocalizationManager.Text("Unavailable");
        ServiceBuild.Text = service?.Detail ?? LocalizationManager.Text("ServiceUnavailableAbout");
        var copyright = $"© {DateTime.Now.Year} EgressView contributors";
        ProductDetails.Text = string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("AboutProductFormat"),
            "EgressView Agent", "EgressView", RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(), copyright);
        LicenseText.Text = ReadResource("Resources/LICENSE.txt");
        NoticesText.Text = ReadResource("Resources/THIRD_PARTY_NOTICES.md");
        copyText = $"EgressView Agent for Windows\r\nUI: {ui.Version} ({ui.Detail})\r\nService: {(service is null ? "unavailable" : $"{service.Version} ({service.Detail})")}\r\nArchitecture: {RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant()}";
    }

    internal static AgentBuildIdentity CurrentUi()
    {
        var assembly = typeof(AboutWindow).Assembly;
        var version = assembly.GetName().Version?.ToString(3) ?? "unknown";
        var build = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion ?? version;
        return new(version, build);
    }

    private static string ReadResource(string path)
    {
        var info = System.Windows.Application.GetResourceStream(new Uri(path, UriKind.Relative));
        if (info is null) return "Unavailable";
        using var reader = new StreamReader(info.Stream);
        return reader.ReadToEnd();
    }

    private void CopyVersion_Click(object sender, RoutedEventArgs e)
    {
        System.Windows.Clipboard.SetText(copyText);
    }
}

internal sealed record AgentBuildIdentity(string Version, string Detail);
