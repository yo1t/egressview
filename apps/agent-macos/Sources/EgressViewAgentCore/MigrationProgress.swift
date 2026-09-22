import Foundation

/// What the store is doing while it cannot answer yet, written where something
/// other than the store can read it.
///
/// Opening the database is the first thing the agent does and, on a large one,
/// the longest. Measured on Windows with a 7.95 GiB database: the service
/// reported itself running after five seconds and could not answer for another
/// 145 (P3-161). Nothing it did in that time was visible, so "still working"
/// and "broken" looked the same, and the user had no way to tell whether to
/// wait, restart, or report it.
///
/// The progress cannot come through the agent's own interface, because that
/// interface is built from the store that is not open yet. So it goes in a file
/// beside the database, and the window reads it only when the agent does not
/// answer -- while the agent answers, its own answer is the better one.
///
/// A file left behind by a process that died mid-migration reads exactly like
/// one being written now, and that is correct: the next launch runs the same
/// migration, so the description is still true.
public struct MigrationProgress: Codable, Equatable, Sendable {
    /// What is happening, in the order it happens.
    public enum Stage: String, Codable, Sendable {
        /// Copying the database so the migration can be undone.
        case backingUp
        /// Moving the schema forward, one version at a time.
        case migrating
    }

    public let stage: Stage
    /// The schema version being left behind, and the one being moved to.
    public let fromVersion: Int
    public let toVersion: Int
    /// The step being applied, when one is.
    public let currentVersion: Int?
    public let startedAt: Date

    public init(
        stage: Stage, fromVersion: Int, toVersion: Int,
        currentVersion: Int? = nil, startedAt: Date = Date()
    ) {
        self.stage = stage
        self.fromVersion = fromVersion
        self.toVersion = toVersion
        self.currentVersion = currentVersion
        self.startedAt = startedAt
    }

    /// Where the file lives for a given database.
    public static func fileURL(forDatabaseAt url: URL) -> URL {
        url.appendingPathExtension("migrating")
    }

    /// Which step of how many, for a caller that puts it into a sentence.
    ///
    /// Stages and steps, never a percentage. The reader's question is whether
    /// anything is happening at all, and a "43%" that does not move for a
    /// minute answers it worse than naming the step.
    ///
    /// The words live in the layer that has the translations; this type carries
    /// the facts.
    public var step: (current: Int, total: Int)? {
        guard stage == .migrating, toVersion > fromVersion else { return nil }
        let current = (currentVersion ?? fromVersion) - fromVersion + 1
        return (max(1, current), toVersion - fromVersion)
    }
}

/// Writes the progress file, and removes it when there is nothing to report.
///
/// Every write is whole-file: a half-written line here would be read by the
/// window as the state of the thing it is waiting for.
public enum MigrationProgressFile {
    public static func write(_ progress: MigrationProgress, forDatabaseAt url: URL) {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(progress) else { return }
        try? data.write(to: fileURL(forDatabaseAt: url), options: .atomic)
    }

    public static func read(forDatabaseAt url: URL) -> MigrationProgress? {
        let path = fileURL(forDatabaseAt: url)
        guard let data = try? Data(contentsOf: path) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(MigrationProgress.self, from: data)
    }

    public static func clear(forDatabaseAt url: URL) {
        try? FileManager.default.removeItem(at: fileURL(forDatabaseAt: url))
    }

    public static func fileURL(forDatabaseAt url: URL) -> URL {
        MigrationProgress.fileURL(forDatabaseAt: url)
    }
}
