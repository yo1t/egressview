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
    public static let schemaVersion = 2

    public let schemaVersion: Int
    public let generatedAt: Date
    public let periodStart: Date
    public let periodEnd: Date
    public let current: AgentLocalInsightCounts
    public let previous: AgentLocalInsightCounts
    public let topApplications: [AgentLocalInsightItem]
    public let topDestinations: [AgentLocalInsightItem]
    /// Traffic worth a look over the last 14 days, with the person's answers
    /// (P3-194). Absent when it could not be read.
    public var outboundCandidates: AgentLocalInsightCandidateList? = nil

    public func encodedPreview() throws -> Data {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return try encoder.encode(self)
    }
}

/// The candidate list as an AI provider sees it: what stood out, against
/// what, and what the person said about it. A note is the person's own words
/// and goes as data, shown in the preview first.
public struct AgentLocalInsightCandidateList: Codable, Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        /// `newPair`, `aboveUsual` or `machine`.
        public let kind: String
        public let day: Date
        public let application: String?
        public let destination: String?
        public let bytesOut: UInt64
        public let usualBytesOut: UInt64?
        /// `expected`, `investigate`, or absent when not answered yet.
        public let answer: String?
        public let note: String?
    }

    /// `learning`, `lowByteCoverage` or `ready`. While learning the list is
    /// empty because nothing can be judged, not because nothing stood out.
    public let state: String
    public let total: Int
    public let entries: [Entry]

    public static let entryLimit = 20

    public init(report: OutboundCandidateReport, judgments: [String: OutboundCandidateJudgment]) {
        switch report.state {
        case .learning: state = "learning"
        case .lowByteCoverage: state = "lowByteCoverage"
        case .ready: state = "ready"
        }
        total = report.total
        entries = report.candidates.prefix(Self.entryLimit).map { candidate in
            let judgment = judgments[candidate.id]
            let note = judgment?.note.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            return Entry(
                kind: candidate.kind.rawValue, day: candidate.at,
                application: candidate.application.map { String($0.prefix(AgentLocalInsightBuilder.nameCharacterLimit)) },
                destination: candidate.destination.map { String($0.prefix(AgentLocalInsightBuilder.nameCharacterLimit)) },
                bytesOut: candidate.bytesOut, usualBytesOut: candidate.usualBytesOut,
                answer: judgment?.verdict.rawValue, note: note.isEmpty ? nil : note
            )
        }
    }
}

public struct AgentLocalInsightSnapshot: Equatable, Sendable {
    public let context: AgentLocalInsightContext
    public let previewSizeBytes: Int

    /// The same snapshot after an answer changed, so the preview and the next
    /// question carry it without waiting for the next refresh.
    public func replacingCandidates(_ candidates: AgentLocalInsightCandidateList?) throws -> AgentLocalInsightSnapshot {
        var context = context
        context.outboundCandidates = candidates
        return AgentLocalInsightSnapshot(context: context, previewSizeBytes: try context.encodedPreview().count)
    }
}

public enum AgentLocalInsightBuilder {
    public static let itemLimit = 10
    public static let nameCharacterLimit = 255

    public static func build(
        current: [AppDestinationTotal],
        previous: [AppDestinationTotal],
        periodStart: Date,
        periodEnd: Date,
        generatedAt: Date = Date(),
        candidates: AgentLocalInsightCandidateList? = nil
    ) throws -> AgentLocalInsightSnapshot {
        let context = AgentLocalInsightContext(
            schemaVersion: AgentLocalInsightContext.schemaVersion,
            generatedAt: generatedAt,
            periodStart: periodStart,
            periodEnd: periodEnd,
            current: counts(current),
            previous: counts(previous),
            topApplications: ranked(current, name: \AppDestinationTotal.processName),
            topDestinations: ranked(current, name: \AppDestinationTotal.destination),
            outboundCandidates: candidates
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
