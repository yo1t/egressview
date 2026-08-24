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
struct AgentRolledUpHistoryNote: View {
    let applies: Bool

    var body: some View {
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
struct AgentPartialCoverageNote: View {
    let count: Int

    var body: some View {
        Label(
            L("%lld connections have no byte count yet. Data volume is measured when a connection ends, so anything still open is not included.", count),
            systemImage: "info.circle"
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
    func agentSection() -> some View { modifier(AgentSectionBackground()) }
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
struct AgentDrawingAccessibility: NSViewRepresentable {
    let label: String

    func makeNSView(context: Context) -> NSView { Surface() }

    func updateNSView(_ view: NSView, context: Context) {
        view.setAccessibilityLabel(label)
    }

    private final class Surface: NSView {
        override func isAccessibilityElement() -> Bool { true }
        override func accessibilityRole() -> NSAccessibility.Role? { .image }
        // Behind the drawing, so it must not swallow clicks meant for it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}

struct AgentChartCard<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder var content: Content

    var body: some View {
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

let agentSeriesPalette: [Color] = [
    .blue, .teal, .indigo, .orange, .pink, .mint, .purple, .brown,
]

func agentSeriesColor(_ index: Int, isRemainder: Bool) -> Color {
    // The remainder is deliberately grey: it is a residue, not a participant,
    // and colouring it like one invites reading it as a single application.
    isRemainder ? Color.secondary.opacity(0.45)
        : agentSeriesPalette[index % agentSeriesPalette.count]
}

struct AgentSeriesLegend: View {
    struct Entry: Identifiable {
        let name: String
        let color: Color
        var id: String { name }
    }

    let entries: [Entry]

    var body: some View {
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

struct AgentEmptyChartNote: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.callout)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 120)
    }
}
