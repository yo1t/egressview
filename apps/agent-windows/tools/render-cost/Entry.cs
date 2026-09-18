using System.Diagnostics;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using EgressView.Agent.Core;
using EgressView.Agent.Ui;
using Application = System.Windows.Application;
using Color = System.Windows.Media.Color;
using Size = System.Windows.Size;
using Grid = System.Windows.Controls.Grid;

namespace RenderCost;

/// Times one frame of each drawn control, so a redraw rate can be argued
/// about in milliseconds rather than in guesses.
///
/// The resident window was measured at 99.6% of one core while the network
/// tab was showing, and 0.1% on every other tab. Two controls redraw on a
/// timer there, and picking the wrong one to fix would have looked like
/// progress. render-check draws each control once to see whether the picture
/// is right; it never asked what a picture costs.
internal static class Entry
{
    [STAThread]
    private static int Main(string[] args)
    {
        var iterations = args.Length > 0 && int.TryParse(args[0], out var value) ? value : 60;
        var application = new Application { ShutdownMode = ShutdownMode.OnExplicitShutdown };
        application.Resources.MergedDictionaries.Add(new ResourceDictionary
        { Source = new Uri("pack://application:,,,/EgressView.Agent.Ui;component/Themes/Fluent.xaml") });
        application.Resources.MergedDictionaries.Add(new ResourceDictionary
        { Source = new Uri("pack://application:,,,/EgressView.Agent.Ui;component/Resources/Strings.ja.xaml") });
        ThemeManager.ApplySystemTheme(application.Resources);

        var visited = new[] { "JP", "US", "AU", "GB", "BR" };
        var points = new List<GlobePoint>
        {
            new(35.68, 139.69, "JP", "Tokyo", 17900, 0),
            new(37.77, -122.42, "US", "San Francisco", 640, 0),
            new(-33.87, 151.21, "AU", "Sydney", 90, 0),
            new(51.50, -0.12, "GB", "London", 260, 0),
            new(-23.55, -46.63, "BR", "Sao Paulo", 40, 0),
        };

        var globe = new WorldGlobeControl { IsRotating = false };
        globe.SetVisitedCountries(visited);
        globe.SetPoints(points);

        var map = new WorldCountryMapControl();
        map.SetVisitedCountries(visited);

        // The glowing case is the one that runs at 15 fps on a machine with
        // traffic, so it is the one worth timing.
        var glowingMap = new WorldCountryMapControl();
        glowingMap.SetVisitedCountries(visited);
        glowingMap.MarkActivity("JP", DateTimeOffset.UtcNow);

        var links = new List<AppDestinationAggregate>
        {
            new("zabbix_agent2", "192.0.2.22", "192.0.2.22", 17900, 2_362_232_012, 0),
            new("svchost", "192.0.2.93", "192.0.2.93", 2409, 97_400_112, 0),
            new("chrome", "142.250.196.100", "Tokyo", 640, 21_000_000, 0),
            new("msedge", "20.190.160.14", "Washington", 410, 9_400_000, 0),
            new("OneDrive", "13.107.42.12", "Redmond", 260, 5_100_000, 0),
        };
        var flow = new NetworkFlowControl();
        flow.SetItems(links, false, false);

        var results = new List<(string Name, int Width, int Height, double Milliseconds)>
        {
            Measure("globe", globe, 330, 260, iterations),
            Measure("country-map (idle)", map, 700, 360, iterations),
            Measure("country-map (glowing)", glowingMap, 700, 360, iterations),
            Measure("sankey", flow, 700, 360, iterations),
        };

        Console.WriteLine($"{iterations} frames each, {Environment.ProcessorCount} cores\n");
        Console.WriteLine($"{"control",-24} {"size",-10} {"ms/frame",9} {"fps",6} {"@fps",6} {"% core",8}");
        foreach (var (name, width, height, ms) in results)
        {
            // The rate each control actually redraws at in the running window.
            var fps = name.StartsWith("globe", StringComparison.Ordinal) ? 5d
                : name.Contains("glowing", StringComparison.Ordinal) ? 15d : 0d;
            var share = fps > 0 ? ms * fps / 10d : 0d;
            Console.WriteLine($"{name,-24} {width + "x" + height,-10} {ms,9:N2} {1000 / ms,6:N1} " +
                $"{(fps > 0 ? fps.ToString("N0") : "-"),6} {(fps > 0 ? share.ToString("N1") : "-"),8}");
        }

        // The globe was 123 ms a frame because its pens were not frozen, and
        // nothing said so: it built, it drew the right picture, and it ate a
        // core. A budget is the only part of this that can fail.
        const double budget = 40;
        var over = results.Where(result => result.Milliseconds > budget).ToArray();
        if (over.Length == 0) return 0;
        Console.Error.WriteLine();
        foreach (var (name, _, _, ms) in over)
            Console.Error.WriteLine($"FAIL: {name} takes {ms:N1} ms per frame, over the {budget:N0} ms budget");
        return 1;
    }

    /// A frame is measured as WPF renders one: layout, then rasterise. Calling
    /// OnRender alone would leave out the part that turns geometry into pixels,
    /// which is where a map of polygons spends its time.
    private static (string, int, int, double) Measure(string name, FrameworkElement element, int width, int height, int iterations)
    {
        element.Width = width;
        element.Height = height;
        var host = new Grid
        {
            Width = width,
            Height = height,
            Background = new SolidColorBrush(Color.FromRgb(0x10, 0x10, 0x14)),
        };
        host.Children.Add(element);
        host.Measure(new Size(width, height));
        host.Arrange(new Rect(0, 0, width, height));
        host.UpdateLayout();

        var target = new RenderTargetBitmap(width, height, 96, 96, PixelFormats.Pbgra32);
        // One frame thrown away: the first pays for atlas parsing, brush
        // freezing and JIT, none of which recur sixty times a second.
        element.InvalidateVisual();
        host.UpdateLayout();
        target.Render(host);

        var watch = Stopwatch.StartNew();
        for (var index = 0; index < iterations; index++)
        {
            element.InvalidateVisual();
            host.UpdateLayout();
            target.Render(host);
        }
        watch.Stop();
        return (name, width, height, watch.Elapsed.TotalMilliseconds / iterations);
    }
}
