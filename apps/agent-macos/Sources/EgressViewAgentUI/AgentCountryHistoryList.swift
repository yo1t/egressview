import EgressViewAgentCore
import SwiftUI

/// One card per country: how many times, when first, when last, and which
/// application went there most recently.
///
/// Its own file because two screens show it -- the card inside the network tab
/// and the expanded atlas (P3-109) -- and a card written twice is a card that
/// drifts.
struct AgentCountryHistoryList: View {
    let rows: [CountryVisitSummary]
    /// The expanded view carries the same title above both panes, and a title
    /// printed twice on one screen reads as two different lists.
    var showsHeading = true

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if showsHeading {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Destination countries"))
                        .font(.title3.bold())
                    Text(L("This list is local and independent of the selected period."))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            if rows.isEmpty {
                AgentEmptyChartNote(text: L("No destination countries have been recorded yet."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(rows) { row in
                            HStack(alignment: .top, spacing: 10) {
                                Text(Self.flag(for: row.countryCode))
                                    .font(.title2)
                                    .accessibilityHidden(true)
                                VStack(alignment: .leading, spacing: 5) {
                                    HStack(alignment: .firstTextBaseline) {
                                        Text(Self.countryName(for: row.countryCode))
                                            .font(.headline)
                                        Spacer(minLength: 8)
                                        Text(L("%lld times", row.connectionCount))
                                            .font(.caption.weight(.semibold))
                                            .monospacedDigit()
                                            .foregroundStyle(.teal)
                                    }
                                    countryHistoryField(
                                        L("First accessed"),
                                        date: row.firstObservedAt
                                    )
                                    countryHistoryField(
                                        L("Last accessed"),
                                        date: row.lastObservedAt
                                    )
                                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                                        Text(L("Latest application"))
                                            .foregroundStyle(.secondary)
                                        Text(row.lastProcessName.isEmpty
                                             ? L("Unknown") : row.lastProcessName)
                                            .lineLimit(1)
                                            .truncationMode(.middle)
                                    }
                                    .font(.caption)
                                }
                            }
                            .padding(10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                RoundedRectangle(cornerRadius: 9, style: .continuous)
                                    .fill(Color.teal.opacity(0.07))
                            )
                        }
                    }
                    .padding(.trailing, 4)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private static func countryName(for code: String) -> String {
        Locale.current.localizedString(forRegionCode: code) ?? code
    }

    private func countryHistoryField(_ label: String, date: Date) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(label)
                .foregroundStyle(.secondary)
            Text(date, format: .dateTime.year().month().day().hour().minute())
                .monospacedDigit()
        }
        .font(.caption)
    }

    private static func flag(for code: String) -> String {
        let scalars = code.uppercased().unicodeScalars.compactMap { scalar -> UnicodeScalar? in
            guard scalar.value >= 65, scalar.value <= 90 else { return nil }
            return UnicodeScalar(127_397 + scalar.value)
        }
        return scalars.count == 2 ? String(String.UnicodeScalarView(scalars)) : ""
    }
}

/// Runs the globe clock and renderer outside SwiftUI. A frame invalidates only
/// this native view instead of re-evaluating the chart card and its controls.
