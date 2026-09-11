import AppKit
import EgressViewAgentCore
import SwiftUI

// The pieces every chart in the window shares: the card around it, the note
// when a period is only partly covered, the palette, the accessibility view
// that VoiceOver can actually land on.

/// Says that part of the period survives only as hourly totals.
///
/// Not a warning -- the data is there and the numbers are right. It exists
/// because three things silently change about the older half: destinations can
/// only be shown as addresses, nothing finer than an hour is distinguishable,
/// and the count of connections whose data volume was never measured is gone.
/// A reader comparing last week with last month would otherwise conclude the
/// names had stopped being recorded.
/// Claimed until 2026-08-24 that a folded destination loses its name. That
/// stopped being true when `chart_hourly` arrived: it keeps the name and
/// covers every folded hour. Measured on a real store -- 91,695 chart rows,
/// 62,458 of them named, and no rolled-up hour outside them. What ages out is
/// the individual connections, not what they were called.
public struct AgentRolledUpHistoryNote: View {
    public let applies: Bool

    public init(applies: Bool) {
        self.applies = applies
    }

    public var body: some View {
        if applies {
            Label(
                L("Part of this period is kept as hourly totals. Individual connections there have aged out, so the log and CSV cannot show them and nothing shorter than an hour is separated out. Destinations keep their names."),
                systemImage: "clock.arrow.circlepath"
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.secondary.opacity(0.08))
            )
        }
    }
}

/// Says what the chart cannot show, rather than letting the gaps read as quiet.
public struct AgentPartialCoverageNote: View {
    let count: Int

    public var body: some View {
        Label(
            L("%lld connections have no byte count yet. Data volume is measured when a connection ends, so anything still open is not included.", count),
            systemImage: "info.circle"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// Says that the vertical axis stops below the tallest bar, and what that bar
/// really was.
///
/// One 1.71 GB hour used to set the axis and draw the other twenty-three hours
/// of a day at nothing (P3-87). Letting the axis stop lower makes the day
/// readable; **not saying so would make the drawing false**, which is worse
/// than the crowding it fixes.
public struct AgentClippedPeakNote: View {
    let count: Int
    let peak: String

    public var body: some View {
        Label(
            L("%1$lld bar(s) run past the top of the axis. The tallest is %2$@, drawn at full height so the rest of the period stays readable.",
              count, peak),
            systemImage: "arrow.up.to.line"
        )
        .font(.caption)
        .foregroundStyle(.secondary)
    }
}

/// The rounded frame every section sits in.
///
/// One shape and one border for all of them: panels that each invent their own
/// corner and edge read as separate apps stitched together rather than as one
/// window.
private struct AgentSectionBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(Color(nsColor: .controlBackgroundColor))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
            )
    }
}

extension View {
    public func agentSection() -> some View { modifier(AgentSectionBackground()) }
}

/// Carries the accessibility element for a drawing that SwiftUI will not give
/// one to.
///
/// Two attempts at this with SwiftUI modifiers did not work on a real Mac. The
/// globe did work, and the only thing separating it from the sankey and the
/// timeline is that the globe is an NSView: `.accessibilityElement()` over an
/// `NSViewRepresentable` lands, and the same modifiers over a `Canvas` do not.
/// So this copies the thing that works rather than guessing at another
/// modifier -- a real view, declaring itself an element, sized to the drawing
/// it stands behind.
public struct AgentDrawingAccessibility: NSViewRepresentable {
    let label: String

    public func makeNSView(context: Context) -> NSView { Surface() }

    public func updateNSView(_ view: NSView, context: Context) {
        view.setAccessibilityLabel(label)
    }

    private final class Surface: NSView {
        override func isAccessibilityElement() -> Bool { true }
        override func accessibilityRole() -> NSAccessibility.Role? { .image }
        // Behind the drawing, so it must not swallow clicks meant for it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

public struct AgentChartCard<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(title).font(.title3.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            // No Spacer here. `content` is told to fill the card, and a Spacer
            // competing for the same space collapsed the sankey canvas to
            // nothing -- the chart vanished with no error, again.
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .agentSection()
    }
}

public let agentSeriesPalette: [Color] = [
    .blue, .teal, .indigo, .orange, .pink, .mint, .purple, .brown,
]

public func agentSeriesColor(_ index: Int, isRemainder: Bool) -> Color {
    // The remainder is deliberately grey: it is a residue, not a participant,
    // and colouring it like one invites reading it as a single application.
    isRemainder ? Color.secondary.opacity(0.45)
        : agentSeriesPalette[index % agentSeriesPalette.count]
}

struct AgentSeriesLegend: View {
    struct Entry: Identifiable {
        let name: String
        let color: Color
        public var id: String { name }
    }

    let entries: [Entry]

    public var body: some View {
        HStack(spacing: 12) {
            ForEach(entries) { entry in
                HStack(spacing: 5) {
                    RoundedRectangle(cornerRadius: 2).fill(entry.color).frame(width: 10, height: 10)
                    Text(entry.name == "Other" ? L("Other") : entry.name)
                        .font(.caption)
                        .lineLimit(1)
                }
            }
        }
    }
}

public struct AgentEmptyChartNote: View {
    let text: String

    public init(text: String) {
        self.text = text
    }

    public var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}

/// How a figure is written on a chart.
///
/// Lived in `AgentThreatPanel.swift` under a `// MARK: - Charts` heading,
/// which is where it was noticed: rendering the charts on their own pulled in
/// the whole threat screen, and through it the window controller, for eight
/// lines of formatting.
public func formattedMetric(_ value: Double, _ metric: TrafficMetric) -> String {
    switch metric {
    case .sessions:
        return Int(value).formatted()
    case .bytes:
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .binary)
    }
}

/// What a period is called on screen.
///
/// Lived in `ObservationWindowController.swift`, so drawing a chart pulled in
/// the whole window -- 974 lines of tabs, pickers and state -- for five
/// strings. The period menu and the charts both need it; neither needs the
/// window.
extension TimeScale: @retroactive Identifiable {
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .hour: return L("Last hour")
        case .sixHours: return L("Last 6 hours")
        case .day: return L("Last 24 hours")
        case .week: return L("Last 7 days")
        case .month: return L("Last 30 days")
        }
    }
}

/// How often the globe redraws.
///
/// Lived in `ObservationWindowController.swift` with the rest of the window's
/// state. The globe reads it every frame; the window only offers it in a menu.
public enum AgentGlobeFrameRate: Int, CaseIterable, Identifiable {
    case energySaver = 3
    case standard = 5
    case smooth = 15

    public static let defaultsKey = "agentGlobeFrameRate"
    public static let defaultValue = AgentGlobeFrameRate.standard

    public var id: Int { rawValue }

    public var title: String {
        switch self {
        case .energySaver: return L("Energy saver (3 fps)")
        case .standard: return L("Standard (5 fps)")
        case .smooth: return L("Smooth (15 fps)")
        }
    }

}
