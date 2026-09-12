import EgressViewAgentCore
import SwiftUI

/// Everywhere this Mac has been, at once: the map on the left, the countries
/// down the right.
///
/// The card inside the network tab can hold one of these at a time and neither
/// comfortably -- the list reads one row at a time and the globe hides half
/// the world. Opened out, the two answer different halves of the same question
/// and answer them together (P3-109).
///
/// Both sides read the same all-time history rather than the selected period,
/// which is what the list has always said about itself.
public struct AgentCountryAtlasView: View {
    let atlas: WorldAtlas?
    let visitedCountryCodes: Set<String>
    let countryHistory: [CountryVisitSummary]
    /// Countries reached in the last few seconds, fading.
    var glow = CountryGlow()
    /// The moment the glow is drawn at; the model advances it while anything
    /// is still fading.
    var now = Date()
    let onCollapse: () -> Void

    public init(
        atlas: WorldAtlas?,
        visitedCountryCodes: Set<String>,
        countryHistory: [CountryVisitSummary],
        glow: CountryGlow = CountryGlow(),
        now: Date = Date(),
        onCollapse: @escaping () -> Void
    ) {
        self.atlas = atlas
        self.visitedCountryCodes = visitedCountryCodes
        self.countryHistory = countryHistory
        self.glow = glow
        self.now = now
        self.onCollapse = onCollapse
    }

    /// Wide enough for the longest card line without the date wrapping, which
    /// is what the small card could not give it.
    private static let listWidth: CGFloat = 320

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text(L("Destination countries"))
                            .font(.title2.weight(.semibold))
                        // How many, said once and said large. The map shows
                        // where and the list shows each one; neither answers
                        // "how far does this reach" in a single number.
                        Text(L("%lld countries", visitedCountryCodes.count))
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                            .foregroundStyle(.teal)
                    }
                    Text(L("This list is local and independent of the selected period."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                Button {
                    onCollapse()
                } label: {
                    Label(L("Shrink"), systemImage: "arrow.down.right.and.arrow.up.left")
                }
                .help(L("Return to the previous size"))
            }

            HStack(alignment: .top, spacing: 16) {
                AgentWorldMapChart(atlas: atlas, visitedCountryCodes: visitedCountryCodes, glow: glow, now: now)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .padding(12)
                    .agentSection()
                AgentCountryHistoryList(rows: countryHistory, showsHeading: false)
                    .frame(width: Self.listWidth)
                    .padding(12)
                    .agentSection()
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
