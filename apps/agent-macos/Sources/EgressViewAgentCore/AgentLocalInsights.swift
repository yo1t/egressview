import Foundation

public struct AgentLocalInsightCounts: Codable, Equatable, Sendable {
    public let connections: Int
    public let applications: Int
    public let destinations: Int
    public let measuredBytes: UInt64
    public let connectionsWithoutBytes: Int
}

public struct AgentLocalInsightItem: Codable, Equatable, Sendable, Identifiable {
    public let name: String
    public let connections: Int
    public let measuredBytes: UInt64

    public var id: String { name }
}

/// The exact bounded value a future AI provider may receive after explicit
/// consent. Keeping this type separate from `ConnectionObservation` makes it
/// impossible to accidentally serialize raw flows, credentials or device
/// notes through the Phase 1 path.
public struct AgentLocalInsightContext: Codable, Equatable, Sendable {
    public static let schemaVersion = 1

    public let schemaVersion: Int
    public let generatedAt: Date
    public let periodStart: Date
    public let periodEnd: Date
    public let current: AgentLocalInsightCounts
    public let previous: AgentLocalInsightCounts
    public let topApplications: [AgentLocalInsightItem]
    public let topDestinations: [AgentLocalInsightItem]

    public func encodedPreview() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

public struct AgentLocalInsightSnapshot: Equatable, Sendable {
    public let context: AgentLocalInsightContext
    public let previewSizeBytes: Int
}

public enum AgentLocalInsightBuilder {
    public static let itemLimit = 10
    public static let nameCharacterLimit = 255

    public static func build(
        current: [AppDestinationTotal],
        previous: [AppDestinationTotal],
        periodStart: Date,
        periodEnd: Date,
        generatedAt: Date = Date()
    ) throws -> AgentLocalInsightSnapshot {
        let context = AgentLocalInsightContext(
            schemaVersion: AgentLocalInsightContext.schemaVersion,
            generatedAt: generatedAt,
            periodStart: periodStart,
            periodEnd: periodEnd,
            current: counts(current),
            previous: counts(previous),
            topApplications: ranked(current, name: \AppDestinationTotal.processName),
            topDestinations: ranked(current, name: \AppDestinationTotal.destination)
        )
        return AgentLocalInsightSnapshot(
            context: context,
            previewSizeBytes: try context.encodedPreview().count
        )
    }

    private static func counts(_ rows: [AppDestinationTotal]) -> AgentLocalInsightCounts {
        AgentLocalInsightCounts(
            connections: rows.reduce(0) { $0 + $1.sessionCount },
            applications: Set(rows.map(\AppDestinationTotal.processName)).count,
            destinations: Set(rows.map(\AppDestinationTotal.destination)).count,
            measuredBytes: rows.reduce(0) { $0 + $1.bytes },
            connectionsWithoutBytes: rows.reduce(0) { $0 + $1.observationsWithoutBytes }
        )
    }

    private static func ranked(
        _ rows: [AppDestinationTotal],
        name: KeyPath<AppDestinationTotal, String>
    ) -> [AgentLocalInsightItem] {
        var totals: [String: (connections: Int, bytes: UInt64)] = [:]
        for row in rows {
            let rawName = row[keyPath: name].trimmingCharacters(in: .whitespacesAndNewlines)
            let nonemptyName = rawName.isEmpty ? "unknown" : rawName
            let key = String(nonemptyName.prefix(nameCharacterLimit))
            totals[key, default: (0, 0)].connections += row.sessionCount
            totals[key, default: (0, 0)].bytes += row.bytes
        }
        return totals.map {
            AgentLocalInsightItem(
                name: $0.key,
                connections: $0.value.connections,
                measuredBytes: $0.value.bytes
            )
        }
        .sorted {
            if $0.connections != $1.connections { return $0.connections > $1.connections }
            return $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        .prefix(itemLimit)
        .map { $0 }
    }
}
