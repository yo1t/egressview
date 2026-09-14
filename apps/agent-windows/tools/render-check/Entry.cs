using System.IO;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Peers;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using EgressView.Agent.Core;
using EgressView.Agent.Ui;
using System.Windows.Controls;
using Application = System.Windows.Application;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;
using Size = System.Windows.Size;
using Control = System.Windows.Controls.Control;
using DataGrid = System.Windows.Controls.DataGrid;
using ListBox = System.Windows.Controls.ListBox;

namespace RenderCheck;

/// Renders the drawn controls offscreen so their layout can be checked
/// without installing a build and looking at the screen.
///
/// A screenshot of the running agent cannot say whether a ribbon overflows
/// its control or the window merely sits off the edge of the display, and it
/// costs an install cycle per attempt.
internal static class Entry
{
    [STAThread]
    private static int Main(string[] args)
    {
        var output = args.Length > 0 ? args[0] : "render-check";
        Directory.CreateDirectory(output);
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        application.Resources.MergedDictionaries.Add(new ResourceDictionary
        { Source = new Uri("pack://application:,,,/EgressView.Agent.Ui;component/Themes/Fluent.xaml") });
        application.Resources.MergedDictionaries.Add(new ResourceDictionary
        { Source = new Uri("pack://application:,,,/EgressView.Agent.Ui;component/Resources/Strings.ja.xaml") });
        ThemeManager.ApplySystemTheme(application.Resources);
        var accent = (SolidColorBrush)application.Resources["AccentBrush"];
        Console.WriteLine($"system theme dark={ThemeManager.IsDark} accent={accent.Color}");

        // Shaped like the real thing: one destination taking most of the
        // volume, a long tail past the top few, and a couple of shares too
        // small to draw. Those are the cases that overflowed.
        var links = new List<AppDestinationAggregate>
        {
            new("zabbix_agent2", "192.0.2.22", "192.0.2.22", 17900, 2_362_232_012, 0),
            new("64DriverLoad", "192.0.2.60", "192.0.2.60", 6122, 149_100_134, 0),
            new("svchost", "192.0.2.93", "192.0.2.93", 2409, 97_400_112, 0),
            new("Creative Cloud UI Helper", "127.0.0.1", "127.0.0.1", 1223, 48_700_000, 0),
            new("tailscaled", "239.255.255.250", "239.255.255.250", 876, 46_400_000, 0),
            new("codex", "255.255.255.255", "255.255.255.255", 783, 43_800_000, 0),
            new("chrome", "142.250.196.100", "Tokyo", 640, 21_000_000, 0),
            new("msedge", "20.190.160.14", "Washington", 410, 9_400_000, 0),
            new("OneDrive", "13.107.42.12", "Redmond", 260, 5_100_000, 0),
            new("Teams", "52.113.194.132", "Dublin", 130, 2_200_000, 0),
            new("SearchApp", "23.62.61.24", "Osaka", 90, 900_000, 0),
            new("tiny", "1.1.1.1", "Sydney", 3, 40, 0),
            new("tinier", "8.8.8.8", "Mountain View", 1, 1, 0),
        };

        // The card is half the window wide and only just taller than its
        // minimum, so the tight sizes are the ones that have to hold.
        foreach (var (label, bytes) in new[] { ("connections", false), ("bytes", true) })
            foreach (var (w, h) in ChartSizes())
            {
                var flow = new NetworkFlowControl();
                VerifyAutomationPeer(flow, "Application to destination flow");
                flow.SetItems(links, bytes, false);
                Save(flow, w, h, Path.Combine(output, $"sankey-{label}-{w}x{h}.png"));
            }

        var globe = new WorldGlobeControl { IsRotating = false };
        VerifyAutomationPeer(globe, "Globe");
        var atlasCountries = WorldAtlas.Load();
        if (!atlasCountries.Any(country => country.Code == "JP") || !atlasCountries.Any(country => country.Code == "US"))
            throw new InvalidOperationException($"Bundled atlas country names did not resolve to ISO codes: count={atlasCountries.Count}, " +
                string.Join(", ", atlasCountries.Where(country => country.Name is "Japan" or "United States of America").Select(country => $"{country.Name}={country.Code ?? "null"}")));
        globe.SetVisitedCountries(["JP", "US", "AU", "GB", "BR"]);
        globe.SetPoints(
        [
            new GlobePoint(35.68, 139.69, "JP", "Tokyo", 17900, 0),
            new GlobePoint(37.77, -122.42, "US", "San Francisco", 640, 0),
            new GlobePoint(-33.87, 151.21, "AU", "Sydney", 90, 0),
            new GlobePoint(51.50, -0.12, "GB", "London", 260, 0),
            new GlobePoint(-23.55, -46.63, "BR", "Sao Paulo", 40, 0),
        ]);
        Save(globe, 330, 260, Path.Combine(output, "globe.png"));

        var countryMap = new WorldCountryMapControl();
        VerifyAutomationPeer(countryMap, "All-time destination countries");
        countryMap.SetVisitedCountries(["JP", "US", "AU", "GB", "BR"]);
        if (countryMap.MappedCountryCount != 5)
            throw new InvalidOperationException("The map and all-time country list disagree on mapped countries.");
        Save(countryMap, 700, 360, Path.Combine(output, "country-atlas.png"));
        var glowAt = DateTimeOffset.UtcNow;
        foreach (var (label, elapsed) in new[] { ("full", 0), ("half", 3), ("ended", 6) })
        {
            var glowingMap = new WorldCountryMapControl();
            glowingMap.SetVisitedCountries(["JP", "US", "AU", "GB", "BR"]);
            glowingMap.MarkActivity("JP", glowAt);
            glowingMap.RenderMoment = glowAt.AddSeconds(elapsed);
            Save(glowingMap, 700, 360, Path.Combine(output, $"country-atlas-glow-{label}.png"));
        }

        var timelineStart = new DateTimeOffset(2026, 9, 6, 10, 0, 0, TimeSpan.FromHours(9));
        var timeline = new List<AppTimelineAggregate>();
        var applications = new[] { "chrome", "codex", "svchost", "tailscaled", "zabbix_agent2", "Other" };
        for (var bucket = 0; bucket < 60; bucket++)
            for (var index = 0; index < applications.Length; index++)
            {
                var connections = Math.Max(0, (bucket * 17 + index * 31) % 95 - index * 7);
                if (connections > 0)
                    timeline.Add(new AppTimelineAggregate(bucket, applications[index], connections,
                        connections * (32_768L + index * 8_192L), 0));
            }
        foreach (var (label, bytes) in new[] { ("connections", false), ("bytes", true) })
            foreach (var (w, h) in ChartSizes())
            {
                var chart = new TrafficTimelineControl();
                VerifyAutomationPeer(chart, "Traffic timeline");
                chart.SetItems(timeline, bytes, timelineStart, timelineStart.AddHours(6),
                    [new SleepPeriod(timelineStart.AddHours(1.5), timelineStart.AddHours(2.25))]);
                Save(chart, w, h, Path.Combine(output, $"timeline-{label}-{w}x{h}.png"));
            }

        foreach (var selectedIndex in new[] { 0, 1 })
        {
            var segmented = new System.Windows.Controls.ListBox
            {
                Style = (Style)application.FindResource("SegmentedSelectorStyle"),
                SelectedIndex = selectedIndex,
            };
            segmented.Items.Add(new ListBoxItem { Content = "接続" });
            segmented.Items.Add(new ListBoxItem { Content = "データ転送量" });
            Save(segmented, 210, 40, Path.Combine(output, $"segmented-metric-{selectedIndex}.png"));
        }
        var globeSegmented = new System.Windows.Controls.ListBox
        {
            Style = (Style)application.FindResource("SegmentedSelectorStyle"),
            SelectedIndex = 1,
        };
        globeSegmented.Items.Add(new ListBoxItem { Content = "地球儀" });
        globeSegmented.Items.Add(new ListBoxItem { Content = "アクセス先の国" });
        Save(globeSegmented, 240, 40, Path.Combine(output, "segmented-globe.png"));

        ThemeManager.ApplyTheme(application.Resources, false, Color.FromRgb(0xD1, 0x34, 0x38));
        var lightSegmented = new System.Windows.Controls.ListBox
        {
            Style = (Style)application.FindResource("SegmentedSelectorStyle"),
            SelectedIndex = 0,
        };
        lightSegmented.Items.Add(new ListBoxItem { Content = "Connections" });
        lightSegmented.Items.Add(new ListBoxItem { Content = "Data volume" });
        Save(lightSegmented, 210, 40, Path.Combine(output, "segmented-light-accent.png"));

        var dashboard = new MainWindow();
        if (dashboard.FindName("ExpandedCountryAtlas") is not Grid ||
            dashboard.FindName("ExpandedCountryList") is not ItemsControl)
            throw new InvalidOperationException("The expandable country atlas is missing from the Windows dashboard.");
        if (MainWindow.LogRefreshInterval != TimeSpan.FromSeconds(5) ||
            MainWindow.LogStreamInterval > TimeSpan.FromSeconds(5))
            throw new InvalidOperationException("The visible dashboard and log must refresh within five seconds.");

        var flowScroll = (ScrollViewer)dashboard.FindName("FlowDiagramScroll")!;
        var dashboardFlow = (NetworkFlowControl)dashboard.FindName("FlowDiagram")!;
        if (flowScroll.VerticalScrollBarVisibility != ScrollBarVisibility.Auto ||
            flowScroll.HorizontalScrollBarVisibility != ScrollBarVisibility.Disabled)
            throw new InvalidOperationException("The application-to-destination chart must scroll vertically, not horizontally.");
        dashboardFlow.SetItems(links, false, false);
        ((Grid)flowScroll.Parent).Children.Remove(flowScroll);
        flowScroll.Margin = new Thickness(0);
        Save(flowScroll, 630, 220, Path.Combine(output, "dashboard-flow-scroll-630x220.png"));
        if (flowScroll.ScrollableHeight < 100)
            throw new InvalidOperationException("The application-to-destination chart has no usable vertical scroll extent.");

        var globeDashboard = new MainWindow();
        var globeCard = (Border)globeDashboard.FindName("CountryGlobeCard")!;
        var globeFooter = (TextBlock)globeDashboard.FindName("GlobeCaption")!;
        var globeControls = (StackPanel)globeDashboard.FindName("GlobeControls")!;
        var spinSpeed = (ListBox)globeDashboard.FindName("SpinSpeedChoice")!;
        globeFooter.Text = "宛先48地点 · ローカルの全期間履歴にある33か国を薄く表示。位置情報がない宛先も含みます。";
        ((Grid)globeCard.Parent).Children.Remove(globeCard);
        Save(globeCard, 340, 510, Path.Combine(output, "globe-controls-340x510.png"));
        if (globeControls.ActualHeight > 41 || spinSpeed.ActualHeight > 41)
            throw new InvalidOperationException("Globe rotation segments stretched with the caption.");

        ThemeManager.ApplyTheme(application.Resources, true, Color.FromRgb(0x4D, 0x94, 0xFF));
        var darkInputSample = new StackPanel { Orientation = System.Windows.Controls.Orientation.Horizontal, Margin = new Thickness(8) };
        var darkTextBox = new System.Windows.Controls.TextBox { Text = "質問を入力", Width = 170, Height = 36 };
        var darkChoice = new System.Windows.Controls.ComboBox { Width = 150, Height = 36, Margin = new Thickness(8, 0, 0, 0) };
        darkChoice.Items.Add(new ComboBoxItem { Content = "7日以内" });
        darkChoice.Items.Add(new ComboBoxItem { Content = "30日以内" });
        darkChoice.SelectedIndex = 0;
        darkInputSample.Children.Add(darkTextBox);
        darkInputSample.Children.Add(darkChoice);
        Save(darkInputSample, 350, 60, Path.Combine(output, "dark-input-controls.png"));
        var darkSurface = ((SolidColorBrush)application.Resources["SurfaceSecondaryBrush"]).Color;
        if (((SolidColorBrush)darkTextBox.Background).Color != darkSurface ||
            ((SolidColorBrush)darkChoice.Background).Color != darkSurface ||
            darkChoice.SelectedIndex != 0)
            throw new InvalidOperationException("Input controls lost their dark theme or selection.");
        foreach (var width in new[] { 630, 340 })
        {
            var countryDashboard = new MainWindow();
            var card = (Border)countryDashboard.FindName("CountryGlobeCard")!;
            var panel = (Grid)countryDashboard.FindName("CountryHistoryPanel")!;
            var globeInCard = (WorldGlobeControl)countryDashboard.FindName("Globe")!;
            var list = (ItemsControl)countryDashboard.FindName("CountryList")!;
            var listScroll = (ScrollViewer)countryDashboard.FindName("CountryListScroll")!;
            var footer = (TextBlock)countryDashboard.FindName("GlobeCaption")!;
            var controls = (StackPanel)countryDashboard.FindName("GlobeControls")!;
            if (listScroll.HorizontalScrollBarVisibility != ScrollBarVisibility.Disabled)
                throw new InvalidOperationException("The country list must not scroll horizontally.");
            list.ItemsSource = Enumerable.Range(0, 20).Select(index => new CountryHistoryDisplayRow
            {
                Code = index == 1 ? "GB" : "IE",
                Country = index == 1 ? "グレートブリテンおよび北アイルランド連合王国" : "アイルランド",
                CountWithUnit = $"{index + 1}回",
                First = "2026/09/13 18:50",
                Last = "2026/09/13 19:34",
                RecentApp = "Creative Cloud UI Helper",
            }).ToArray();
            globeInCard.Visibility = Visibility.Collapsed;
            panel.Visibility = Visibility.Visible;
            controls.Visibility = Visibility.Collapsed;
            footer.Text = "宛先48地点 · ローカルの全期間履歴にある33か国を薄く表示";
            ((Grid)card.Parent).Children.Remove(card);
            Save(card, width, 510, Path.Combine(output, $"country-list-{width}x510.png"));
            var viewportBottom = listScroll.TransformToAncestor(card).Transform(new System.Windows.Point(0, listScroll.ActualHeight)).Y;
            var footerTop = footer.TransformToAncestor(card).Transform(new System.Windows.Point(0, 0)).Y;
            var footerBottom = footerTop + footer.ActualHeight;
            Console.WriteLine($"country-list-{width}: viewportBottom={viewportBottom:F1} footerTop={footerTop:F1} footerBottom={footerBottom:F1} cardHeight={card.ActualHeight:F1}");
            if (viewportBottom > footerTop)
                throw new InvalidOperationException($"Country list overlaps footer at width {width}: {viewportBottom} > {footerTop}");
            if (footerBottom > card.ActualHeight - 12)
                throw new InvalidOperationException($"Country list footer is clipped at width {width}: {footerBottom} > {card.ActualHeight - 12}");
        }

        if (CountryHistoryDisplayRow.LocalizedCountryName("IE", "ja") != "アイルランド" ||
            CountryHistoryDisplayRow.LocalizedCountryName("IE", "en") != "Ireland")
            throw new InvalidOperationException("Country names do not follow the selected UI language.");

        foreach (var (width, height) in new[] { (1400, 930), (960, 680) })
        {
            var insightsWindow = new MainWindow();
            var insightsTab = (TabItem)insightsWindow.MainTabs.Items[1];
            var insights = (ScrollViewer)insightsTab.Content;
            if (insights.HorizontalScrollBarVisibility != ScrollBarVisibility.Disabled)
                throw new InvalidOperationException("Insights must not scroll horizontally.");
            ((TextBlock)insightsWindow.FindName("InsightConnections")!).Text = "11,415";
            ((TextBlock)insightsWindow.FindName("InsightApplications")!).Text = "44";
            ((TextBlock)insightsWindow.FindName("InsightDestinations")!).Text = "188";
            ((TextBlock)insightsWindow.FindName("InsightBytes")!).Text = "359.9 MiB";
            ((TextBlock)insightsWindow.FindName("InsightConnectionsDelta")!).Text = "前期間比 -31%";
            ((TextBlock)insightsWindow.FindName("InsightApplicationsDelta")!).Text = "前期間比 +4%";
            ((TextBlock)insightsWindow.FindName("InsightDestinationsDelta")!).Text = "前期間比 +12%";
            ((TextBlock)insightsWindow.FindName("InsightUnmeasured")!).Text = "123件はデータ量未計測";
            ((TextBlock)insightsWindow.FindName("InsightChangeSummary")!).Text = "接続数は前期間より31%減りました。";
            ((TextBlock)insightsWindow.FindName("InsightTopApp")!).Text = "接続が最も多いアプリ：svchost（5,120件）。";
            ((TextBlock)insightsWindow.FindName("InsightTopDestination")!).Text = "接続が最も多い通信先：edge-mqtt.facebook.com（2,311件）。";
            ((ItemsControl)insightsWindow.FindName("TopApplicationsList")!).ItemsSource =
                new[] { new RankedRow("svchost", 5_120, false), new RankedRow("Creative Cloud UI Helper", 1_420, false) };
            ((ItemsControl)insightsWindow.FindName("TopDestinationsList")!).ItemsSource =
                new[] { new RankedRow("edge-mqtt.facebook.com", 2_311, false), new RankedRow("takizawa.egressview.com", 1_043, false) };
            insightsTab.Content = null;
            insights.SetResourceReference(Control.ForegroundProperty, "TextPrimaryBrush");
            insights.SetResourceReference(Control.BackgroundProperty, "AppBackgroundBrush");
            Save(insights, width, height, Path.Combine(output, $"insights-{width}x{height}.png"));
        }

        var logWindow = new MainWindow();
        var logTab = (TabItem)logWindow.MainTabs.Items[2];
        var logPage = (Grid)logTab.Content;
        var logRows = Enumerable.Range(0, 60).Select(index => new FlowRow(new RecentFlow(
            new DateTimeOffset(2026, 9, 13, 11, 28, index % 60, TimeSpan.FromHours(9)),
            new DateTimeOffset(2026, 9, 13, 19, 51, index % 60, TimeSpan.FromHours(9)),
            index % 2 == 0 ? "UDP" : "TCP", "192.0.2.1", 50_000, "224.0.0.251", 5353, index,
            index % 3 == 0 ? "Creative Cloud UI Helper" : "ChatGPT", 256 + index, 1_024 + index,
            ObservationLayer.Logical, null, "etw", "edge-mqtt.facebook.com", "IE"))).ToArray();
        ((DataGrid)logWindow.FindName("ConnectionGrid")!).ItemsSource = logRows;
        ((TextBlock)logWindow.FindName("LogStatus")!).Text = "表示中 60 / 読込対象 60 件 · 有効なfilter 0";
        logTab.Content = null;
        logPage.SetValue(System.Windows.Documents.TextElement.ForegroundProperty, application.Resources["TextPrimaryBrush"]);
        Save(logPage, 1400, 900, Path.Combine(output, "connection-log-1400x900.png"));
        if (logRows[0].Country != CountryHistoryDisplayRow.LocalizedCountryName("IE", LocalizationManager.EffectiveLanguage)
            || logRows[0].DataVolumeText == "—")
            throw new InvalidOperationException("The log must show localized country names and total data volume.");

        var threatWindow = new MainWindow();
        var threatTab = (TabItem)threatWindow.MainTabs.Items[3];
        var threatPage = (ScrollViewer)threatTab.Content;
        ((Border)threatWindow.FindName("ThreatEmptyNote")!).Visibility = Visibility.Collapsed;
        ((Border)threatWindow.FindName("ThreatTableCard")!).Visibility = Visibility.Visible;
        ((Border)threatWindow.FindName("ThreatDetailCard")!).Visibility = Visibility.Visible;
        ((DataGrid)threatWindow.FindName("ThreatGrid")!).ItemsSource = new[] { new ThreatRow(new ThreatFinding(
            "api.github.com", "20.27.177.116", "api.github.com", "chrome", 12, 28_672, 0,
            DateTimeOffset.Now.AddHours(-2), DateTimeOffset.Now, "domain", "github.com", "Sample feed", "listed", "low")) };
        ((TextBlock)threatWindow.FindName("ThreatStatus")!).Text = "脅威情報と一致する通信を1件確認しました。";
        ((TextBlock)threatWindow.FindName("ThreatStatus")!).Visibility = Visibility.Visible;
        ((DataGrid)threatWindow.FindName("ThreatGrid")!).SelectedIndex = 0;
        var threatFields = (ItemsControl)threatWindow.FindName("ThreatDetailFields")!;
        if (threatFields.Items.Count != 11 || threatFields.Visibility != Visibility.Visible)
            throw new InvalidOperationException("Threat evidence must render as eleven vertical fields.");
        threatTab.Content = null;
        threatPage.SetResourceReference(Control.ForegroundProperty, "TextPrimaryBrush");
        threatPage.SetResourceReference(Control.BackgroundProperty, "AppBackgroundBrush");
        Save(threatPage, 1400, 900, Path.Combine(output, "threats-1400x900.png"));

        var notificationWindow = new MainWindow();
        var notificationTab = (TabItem)notificationWindow.MainTabs.Items[4];
        var notificationPage = (ScrollViewer)notificationTab.Content;
        ((TextBlock)notificationWindow.FindName("NotificationSentToday")!).Text = "3";
        ((TextBlock)notificationWindow.FindName("NotificationSuppressedToday")!).Text = "1";
        ((TextBlock)notificationWindow.FindName("NotificationPermissionCard")!).Text = "有効";
        ((TextBlock)notificationWindow.FindName("NotificationSummary")!).Text = "今日の試行: 4 · 今日の表示: 3 · 今日の抑制: 1";
        ((ItemsControl)notificationWindow.FindName("NotificationList")!).ItemsSource = Enumerable.Range(0, 6).Select(index =>
            new NotificationRow(new NotificationHistoryEntry(DateTimeOffset.Now.AddMinutes(-index * 25),
                "HubDelivery", "EgressView Agent", $"Hubへの送信が完了していません。未送信 {index + 97} 件。",
                false, "suppressed-daily-limit"))).ToArray();
        notificationTab.Content = null;
        notificationPage.SetResourceReference(Control.ForegroundProperty, "TextPrimaryBrush");
        notificationPage.SetResourceReference(Control.BackgroundProperty, "AppBackgroundBrush");
        Save(notificationPage, 1400, 900, Path.Combine(output, "notifications-1400x900.png"));

        Console.WriteLine($"wrote {output}");
        return 0;
    }

    private static void VerifyAutomationPeer(FrameworkElement element, string name)
    {
        AutomationProperties.SetName(element, name);
        var peer = UIElementAutomationPeer.CreatePeerForElement(element)
            ?? throw new InvalidOperationException($"No automation peer: {element.GetType().Name}");
        if (peer.GetName() != name)
            throw new InvalidOperationException($"Automation name mismatch: {element.GetType().Name}");
    }

    /// Whether anything was painted outside the control's own bounds, in
    /// pixels. Reading it off a picture is guesswork; counting it is not.
    private static IReadOnlyList<(int Width, int Height)> ChartSizes()
    {
        // The lower bound comes from the window's actual MinWidth and the
        // two equally sized bottom cards (outer margin, gap and card padding).
        // The remaining cases exercise larger windows and compressed heights.
        var minimumCardWidth = (MainWindow.MinimumWindowWidth - 64 - 14) / 2 - 48;
        var minimum = (int)Math.Floor(minimumCardWidth);
        return [(minimum, 170), (minimum - 30, 150), (minimum - 90, 120), (minimum + 240, 200)];
    }

    private static void Report(RenderTargetBitmap bitmap, int width, int height, int bleed, string name)
    {
        var stride = bitmap.PixelWidth * 4;
        var pixels = new byte[stride * bitmap.PixelHeight];
        bitmap.CopyPixels(pixels, stride, 0);
        bool Painted(int x, int y)
        {
            var i = y * stride + x * 4;
            // The host's own ground, and the red frame drawn on top of it.
            var isGround = pixels[i] == 0x14 && pixels[i + 1] == 0x10 && pixels[i + 2] == 0x10;
            var isFrame = pixels[i + 2] > 0xC0 && pixels[i + 1] < 0x40 && pixels[i] < 0x40;
            return !isGround && !isFrame;
        }
        int above = 0, below = 0, left = 0, right = 0;
        for (var y = 0; y < bitmap.PixelHeight; y++)
            for (var x = 0; x < bitmap.PixelWidth; x++)
            {
                if (!Painted(x, y)) continue;
                if (y < bleed) above = Math.Max(above, bleed - y);
                if (y >= bleed + height) below = Math.Max(below, y - (bleed + height) + 1);
                if (x < bleed) left = Math.Max(left, bleed - x);
                if (x >= bleed + width) right = Math.Max(right, x - (bleed + width) + 1);
            }
        Console.WriteLine($"{name}: {width}x{height} overflow above={above} below={below} left={left} right={right}");
        if (above != 0 || below != 0 || left != 0 || right != 0)
            throw new InvalidOperationException($"{name} painted outside its {width}x{height} bounds");
    }

    private static void Save(FrameworkElement element, int width, int height, string path)
    {
        element.Width = width;
        element.Height = height;
        // A margin of blank around the control: anything the control paints
        // outside its own bounds lands here instead of being cropped away,
        // which is exactly the failure being looked for.
        const int bleed = 40;
        var host = new Grid
        {
            Width = width + bleed * 2,
            Height = height + bleed * 2,
            Background = new SolidColorBrush(Color.FromRgb(0x10, 0x10, 0x14)),
        };
        var frame = new System.Windows.Shapes.Rectangle
        {
            Width = width, Height = height, Stroke = Brushes.Red, StrokeThickness = 1, Fill = Brushes.Transparent,
        };
        host.Children.Add(element);
        host.Children.Add(frame);
        host.Measure(new Size(host.Width, host.Height));
        host.Arrange(new Rect(0, 0, host.Width, host.Height));
        host.UpdateLayout();
        var bitmap = new RenderTargetBitmap((int)host.Width, (int)host.Height, 96, 96, PixelFormats.Pbgra32);
        bitmap.Render(host);
        var encoder = new PngBitmapEncoder();
        encoder.Frames.Add(BitmapFrame.Create(bitmap));
        using (var stream = File.Create(path)) encoder.Save(stream);
        Report(bitmap, width, height, bleed, Path.GetFileName(path));
    }
}
