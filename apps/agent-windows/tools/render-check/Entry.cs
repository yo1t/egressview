using System.IO;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using EgressView.Agent.Core;
using EgressView.Agent.Ui;
using System.Windows.Controls;
using Application = System.Windows.Application;
using Brushes = System.Windows.Media.Brushes;
using Color = System.Windows.Media.Color;
using Size = System.Windows.Size;

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
            foreach (var (w, h) in new[] { (700, 200), (520, 170), (420, 150), (360, 120) })
            {
                var flow = new NetworkFlowControl();
                flow.SetItems(links, bytes, false);
                Save(flow, w, h, Path.Combine(output, $"sankey-{label}-{w}x{h}.png"));
            }

        var globe = new WorldGlobeControl { IsRotating = false };
        globe.SetPoints(
        [
            new GlobePoint(35.68, 139.69, "JP", "Tokyo", 17900, 0),
            new GlobePoint(37.77, -122.42, "US", "San Francisco", 640, 0),
            new GlobePoint(-33.87, 151.21, "AU", "Sydney", 90, 0),
            new GlobePoint(51.50, -0.12, "GB", "London", 260, 0),
            new GlobePoint(-23.55, -46.63, "BR", "Sao Paulo", 40, 0),
        ]);
        Save(globe, 330, 260, Path.Combine(output, "globe.png"));

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
            foreach (var (w, h) in new[] { (700, 200), (520, 170), (420, 150), (360, 120) })
            {
                var chart = new TrafficTimelineControl();
                chart.SetItems(timeline, bytes, timelineStart, timelineStart.AddHours(6));
                Save(chart, w, h, Path.Combine(output, $"timeline-{label}-{w}x{h}.png"));
            }

        Console.WriteLine($"wrote {output}");
        return 0;
    }

    /// Whether anything was painted outside the control's own bounds, in
    /// pixels. Reading it off a picture is guesswork; counting it is not.
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
