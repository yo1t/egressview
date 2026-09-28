using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using EgressView.Agent.Core;

namespace EgressView.Agent.Ui;

/// What appears when the pointer rests on the outbound-anomaly card or on a
/// notice in the history (P3-180).
///
/// A panel laid out as a small table rather than a line of tooltip text:
/// what it holds is a window, an amount against the usual one, and two short
/// ranked lists, which a single run of text cannot show readably. Half a
/// second before it opens, so moving across the window does not flash it, and
/// it stays while the pointer does.
internal static class AnomalyDetailView
{
    internal const int OpenDelayMilliseconds = 500;
    private const int StayMilliseconds = 120_000;

    /// A tooltip styled like the window's own cards, holding <paramref name="content"/>.
    internal static System.Windows.Controls.ToolTip Wrap(FrameworkElement content)
    {
        var tip = new System.Windows.Controls.ToolTip { Content = content, Padding = new Thickness(14), MaxWidth = 460, HasDropShadow = true };
        tip.SetResourceReference(System.Windows.Controls.Control.BackgroundProperty, "SurfaceBrush");
        tip.SetResourceReference(System.Windows.Controls.Control.ForegroundProperty, "TextPrimaryBrush");
        tip.SetResourceReference(System.Windows.Controls.Control.BorderBrushProperty, "StrokeBrush");
        return tip;
    }

    /// Opens after half a second and stays while the pointer does.
    internal static void Attach(FrameworkElement target, FrameworkElement content)
    {
        target.ToolTip = Wrap(content);
        ToolTipService.SetInitialShowDelay(target, OpenDelayMilliseconds);
        ToolTipService.SetShowDuration(target, StayMilliseconds);
        ToolTipService.SetBetweenShowDelay(target, 0);
    }

    /// The period's anomalies for the overview card, newest first.
    internal static FrameworkElement List(IReadOnlyList<OutboundAnomalyRecord> records, int total, bool baselineReady)
    {
        var panel = new StackPanel { Width = 420 };
        panel.Children.Add(Heading(LocalizationManager.Text("AnomaliesInPeriod"), 15));
        if (records.Count == 0)
        {
            // "None found" and "cannot judge yet" are different answers, as
            // the dash on the card already says.
            panel.Children.Add(Secondary(LocalizationManager.Text(total == 0 && !baselineReady ? "AnomalyBaselineNotReady" : "NoAnomaliesInPeriod"), 6));
            return panel;
        }
        for (var index = 0; index < records.Count; index++)
        {
            if (index > 0) panel.Children.Add(Rule());
            panel.Children.Add(Anomaly(records[index]));
        }
        if (total > records.Count)
            panel.Children.Add(Secondary(string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("ShowingNewestFormat"), records.Count, total), 10));
        panel.Children.Add(Secondary(LocalizationManager.Text("AnomalyNotMalware"), 10));
        return panel;
    }

    /// One flagged fifteen minutes, explained as far as what was kept allows.
    internal static FrameworkElement Anomaly(OutboundAnomalyRecord record)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        var header = new DockPanel();
        var window = Secondary(Window(record), 0);
        DockPanel.SetDock(window, Dock.Right);
        window.Margin = new Thickness(12, 0, 0, 0);
        header.Children.Add(window);
        header.Children.Add(Heading(LocalizationManager.Text(record.Kind == OutboundAnomalyKind.DistributedTransfer
            ? "AnomalyDistributedTransfer" : "AnomalyLargeTransfer"), 13));
        panel.Children.Add(header);

        var facts = new Grid { Margin = new Thickness(0, 6, 0, 0) };
        facts.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        facts.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        AddFact(facts, LocalizationManager.Text("SentVolume"), Bytes(record.BytesOut));
        if (record.Breakdown is { } usual) AddFact(facts, LocalizationManager.Text("UsualFor15Minutes"), Bytes(usual.UsualBytesOut));
        AddFact(facts, LocalizationManager.Text("Applications"), record.ApplicationCount.ToString("N0", CultureInfo.CurrentCulture));
        AddFact(facts, LocalizationManager.Text("Destinations"), record.DestinationCount.ToString("N0", CultureInfo.CurrentCulture));
        panel.Children.Add(facts);

        if (record.Breakdown is not { } breakdown)
        {
            // Said rather than left blank: an empty space here would read as
            // "nobody sent it".
            panel.Children.Add(Secondary(LocalizationManager.Text("AnomalyBreakdownNotRecorded"), 6));
            return panel;
        }
        // Which application sent to which destination, first: the two lists
        // below rank each side on its own, and the largest sender and the
        // largest destination need not be the same connection.
        if (breakdown.Pairs is { Count: > 0 } pairs)
            panel.Children.Add(Pairs(pairs));
        if (breakdown.Applications.Count > 0)
            panel.Children.Add(Contributors(LocalizationManager.Text("AppsSentMost"), breakdown.Applications));
        if (breakdown.Destinations.Count > 0)
        {
            panel.Children.Add(Contributors(LocalizationManager.Text("DestinationsSentMost"), breakdown.Destinations));
            var others = breakdown.SendingDestinationCount - breakdown.Destinations.Count;
            if (others > 0)
                panel.Children.Add(Secondary(string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("OtherDestinationsFormat"), others), 3));
        }
        return panel;
    }

    /// A notice in the history. An anomaly notice shows what the card shows;
    /// any other kind shows its whole text and the exact time, which the row
    /// shortens to the minute.
    internal static FrameworkElement Notice(NotificationHistoryEntry entry)
    {
        var panel = new StackPanel { Width = 420 };
        var header = new DockPanel();
        var time = Secondary(entry.Date.LocalDateTime.ToString("G", CultureInfo.CurrentCulture), 0);
        DockPanel.SetDock(time, Dock.Right);
        time.Margin = new Thickness(12, 0, 0, 0);
        header.Children.Add(time);
        header.Children.Add(Heading(entry.Title, 14));
        panel.Children.Add(header);
        panel.Children.Add(Body(entry.Body, 6));
        if (entry.Kind == "OutboundAnomaly")
        {
            panel.Children.Add(Rule());
            if (entry.Anomaly is { } record) panel.Children.Add(Anomaly(record));
            else panel.Children.Add(Secondary(LocalizationManager.Text("NoticeDetailsNotRecorded"), 6));
            panel.Children.Add(Secondary(LocalizationManager.Text("AnomalyNotMalware"), 10));
        }
        else if (entry.Kind == "Threat")
        {
            panel.Children.Add(Rule());
            if (entry.Threats is not { } threats)
                panel.Children.Add(Secondary(LocalizationManager.Text("NoticeDetailsNotRecorded"), 6));
            else
            {
                for (var index = 0; index < threats.Count; index++)
                {
                    if (index > 0) panel.Children.Add(Rule());
                    panel.Children.Add(Threat(threats[index]));
                }
                if (entry.MoreThreats > 0)
                    panel.Children.Add(Secondary(string.Format(CultureInfo.CurrentCulture, LocalizationManager.Text("MoreThreatsFormat"), entry.MoreThreats), 10));
            }
            panel.Children.Add(Secondary(LocalizationManager.Text("FeedNotProof"), 10));
        }
        return panel;
    }

    /// One match as it stood when the notice went out.
    internal static FrameworkElement Threat(ThreatFinding finding)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        panel.Children.Add(Heading(finding.Destination, 13));
        var facts = new Grid { Margin = new Thickness(0, 6, 0, 0) };
        facts.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        facts.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        AddFact(facts, LocalizationManager.Text("Process"), finding.Application);
        AddFact(facts, LocalizationManager.Text("MatchedValue"), $"{finding.IndicatorKind.ToUpperInvariant()} · {finding.MatchedValue}");
        AddFact(facts, LocalizationManager.Text("Feed"), finding.Source ?? "—");
        AddFact(facts, LocalizationManager.Text("Reason"), finding.Tag ?? "—");
        AddFact(facts, LocalizationManager.Text("Confidence"), LocalizationManager.Text(finding.Confidence == "high" ? "HighAction" : "LowAction"));
        AddFact(facts, LocalizationManager.Text("Connections"), finding.Connections.ToString("N0", CultureInfo.CurrentCulture));
        AddFact(facts, LocalizationManager.Text("DataVolume"), finding.ConnectionsWithoutBytes == 0 ? FlowRow.FormatBytes(finding.Bytes) :
            $"{FlowRow.FormatBytes(finding.Bytes)} + {finding.ConnectionsWithoutBytes:N0} {LocalizationManager.Text("Unmeasured").ToLower(CultureInfo.CurrentCulture)}");
        AddFact(facts, LocalizationManager.Text("FirstSeen"), finding.FirstSeen.LocalDateTime.ToString("g", CultureInfo.CurrentCulture));
        AddFact(facts, LocalizationManager.Text("LastSeen"), finding.LastSeen.LocalDateTime.ToString("g", CultureInfo.CurrentCulture));
        panel.Children.Add(facts);
        return panel;
    }

    private static string Window(OutboundAnomalyRecord record) =>
        $"{record.WindowStart.LocalDateTime.ToString("g", CultureInfo.CurrentCulture)}–{record.WindowEnd.LocalDateTime.ToString("t", CultureInfo.CurrentCulture)}";

    private static string Bytes(ulong value) => FlowRow.FormatBytes((long)Math.Min(value, long.MaxValue));

    private static FrameworkElement Contributors(string title, IReadOnlyList<OutboundContributor> rows)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        var heading = Secondary(title, 0);
        heading.FontWeight = FontWeights.SemiBold;
        panel.Children.Add(heading);
        foreach (var row in rows)
        {
            var line = new DockPanel { Margin = new Thickness(0, 2, 0, 0) };
            var amount = Secondary(Bytes(row.BytesOut), 0);
            amount.Margin = new Thickness(12, 0, 0, 0);
            DockPanel.SetDock(amount, Dock.Right);
            line.Children.Add(amount);
            line.Children.Add(new TextBlock
            {
                // An application the collector could not name is still one
                // that sent something.
                Text = string.IsNullOrEmpty(row.Name) ? "—" : row.Name,
                TextTrimming = TextTrimming.CharacterEllipsis,
            });
            panel.Children.Add(line);
        }
        return panel;
    }

    private static FrameworkElement Pairs(IReadOnlyList<OutboundPair> pairs)
    {
        var panel = new StackPanel { Margin = new Thickness(0, 8, 0, 0) };
        var heading = Secondary(LocalizationManager.Text("PairsSentMost"), 0);
        heading.FontWeight = FontWeights.SemiBold;
        panel.Children.Add(heading);
        foreach (var pair in pairs)
        {
            var line = new DockPanel { Margin = new Thickness(0, 2, 0, 0) };
            var amount = Secondary(Bytes(pair.BytesOut), 0);
            amount.Margin = new Thickness(12, 0, 0, 0);
            DockPanel.SetDock(amount, Dock.Right);
            line.Children.Add(amount);
            var text = new TextBlock { TextTrimming = TextTrimming.CharacterEllipsis };
            text.Inlines.Add(new System.Windows.Documents.Run(string.IsNullOrEmpty(pair.Application) ? "—" : pair.Application) { FontWeight = FontWeights.SemiBold });
            text.Inlines.Add(new System.Windows.Documents.Run(" → " + pair.Destination));
            line.Children.Add(text);
            panel.Children.Add(line);
        }
        return panel;
    }

    private static void AddFact(Grid grid, string label, string value)
    {
        var row = grid.RowDefinitions.Count;
        grid.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        var name = Secondary(label, 0);
        name.Margin = new Thickness(0, 2, 14, 0);
        Grid.SetRow(name, row);
        var text = new TextBlock { Text = value, Margin = new Thickness(0, 2, 0, 0), TextWrapping = TextWrapping.Wrap };
        Grid.SetRow(text, row);
        Grid.SetColumn(text, 1);
        grid.Children.Add(name);
        grid.Children.Add(text);
    }

    private static TextBlock Heading(string text, double size) =>
        new() { Text = text, FontSize = size, FontWeight = FontWeights.SemiBold, TextWrapping = TextWrapping.Wrap };

    private static TextBlock Body(string text, double top) =>
        new() { Text = text, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, top, 0, 0) };

    private static TextBlock Secondary(string text, double top)
    {
        var block = new TextBlock { Text = text, FontSize = 12, TextWrapping = TextWrapping.Wrap, Margin = new Thickness(0, top, 0, 0) };
        block.SetResourceReference(TextBlock.ForegroundProperty, "TextSecondaryBrush");
        return block;
    }

    private static Separator Rule() => new() { Margin = new Thickness(0, 10, 0, 2) };
}
