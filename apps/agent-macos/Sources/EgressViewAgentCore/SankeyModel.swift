import Foundation

/// What the ribbon width means.
///
/// The two answer different questions and neither substitutes for the other:
/// a beacon sending 1 KB ten thousand times and an upload sending 1 GB once
/// are invisible to each other's measure.
public enum TrafficMetric: String, Equatable, Sendable, CaseIterable {
    case sessions
    case bytes
}

public struct SankeyNode: Equatable, Sendable {
    public let name: String
    public let value: Double
    /// True for the folded remainder. It is kept rather than dropped so the
    /// share of what is not shown stays visible.
    public let isRemainder: Bool
}

public struct SankeyLink: Equatable, Sendable {
    public let source: String
    public let target: String
    public let value: Double
}

public struct SankeyModel: Equatable, Sendable {
    public let metric: TrafficMetric
    public let apps: [SankeyNode]
    public let destinations: [SankeyNode]
    public let links: [SankeyLink]
    public let total: Double
    /// Observations whose byte counts were never reported, so the user can be
    /// told what the byte view does not include.
    ///
    /// Byte counts arrive when a flow closes, so a long-running flow
    /// contributes nothing until it ends. Drawing that as zero would claim
    /// silence where nothing was measured.
    public let observationsWithoutBytes: Int

    public var isEmpty: Bool { links.isEmpty }

    /// Whether the byte view is missing enough data to be misleading on its own.
    public var byteCoverageIsPartial: Bool {
        metric == .bytes && observationsWithoutBytes > 0
    }
}

/// Folds raw per-app-per-destination totals into a two-layer diagram that fits
/// on one screen.
public struct SankeyAggregator: Sendable {
    /// A single Mac produced over 100,000 observations in a day in production.
    /// Everything must be folded before it can be read.
    public static let defaultLimit = 8

    public let remainderName: String
    private let limit: Int

    public init(limit: Int = SankeyAggregator.defaultLimit, remainderName: String = "Other") {
        self.limit = max(1, limit)
        self.remainderName = remainderName
    }

    public func aggregate(_ rows: [AppDestinationTotal], metric: TrafficMetric) -> SankeyModel {
        let weighted = rows.compactMap { row -> (app: String, destination: String, value: Double)? in
            let value = metric == .sessions ? Double(row.sessionCount) : Double(row.bytes)
            // A zero-width ribbon is not a fact about the traffic, it is the
            // absence of a measurement. Leaving it out is honest; drawing it
            // would not be.
            guard value > 0 else { return nil }
            return (row.processName, row.destination, value)
        }
        let unknown = rows.reduce(0) { $0 + $1.observationsWithoutBytes }

        guard !weighted.isEmpty else {
            return SankeyModel(
                metric: metric, apps: [], destinations: [], links: [],
                total: 0, observationsWithoutBytes: unknown
            )
        }

        let appTotals = totals(weighted.map { ($0.app, $0.value) })
        let destinationTotals = totals(weighted.map { ($0.destination, $0.value) })
        let keptApps = keep(appTotals)
        let keptDestinations = keep(destinationTotals)

        var linkTotals: [String: Double] = [:]
        for entry in weighted {
            let app = keptApps.contains(entry.app) ? entry.app : remainderName
            let destination = keptDestinations.contains(entry.destination)
                ? entry.destination
                : remainderName
            linkTotals["\(app)\u{0}\(destination)", default: 0] += entry.value
        }

        let links = linkTotals
            .map { key, value in
                let parts = key.components(separatedBy: "\u{0}")
                return SankeyLink(source: parts[0], target: parts[1], value: value)
            }
            .sorted { ($0.value, $0.source, $0.target) > ($1.value, $1.source, $1.target) }

        return SankeyModel(
            metric: metric,
            apps: nodes(from: links.map { ($0.source, $0.value) }),
            destinations: nodes(from: links.map { ($0.target, $0.value) }),
            links: links,
            total: weighted.reduce(0) { $0 + $1.value },
            observationsWithoutBytes: unknown
        )
    }

    private func totals(_ pairs: [(String, Double)]) -> [String: Double] {
        pairs.reduce(into: [:]) { $0[$1.0, default: 0] += $1.1 }
    }

    /// The names large enough to stand on their own. Ties break by name so the
    /// diagram does not reshuffle between identical readings.
    private func keep(_ totals: [String: Double]) -> Set<String> {
        Set(
            totals.sorted { ($0.value, $1.key) > ($1.value, $0.key) }
                .prefix(limit)
                .map(\.key)
        )
    }

    private func nodes(from pairs: [(String, Double)]) -> [SankeyNode] {
        totals(pairs)
            .map { SankeyNode(name: $0.key, value: $0.value, isRemainder: $0.key == remainderName) }
            // The remainder sits last however large it is: it is a residue, not
            // a participant.
            .sorted {
                if $0.isRemainder != $1.isRemainder { return !$0.isRemainder }
                return ($0.value, $1.name) > ($1.value, $0.name)
            }
    }
}
