import Foundation

/// What the copies taken before past migrations are costing, and whether the
/// last one finished.
///
/// The copy is insurance (P3-161): before the store changes shape it writes
/// `<database>.pre-v<N>.sqlite` so a migration that fails can be undone. The
/// name carries the version being left behind, so **one copy survives per
/// schema version the agent has ever upgraded from** -- they are not replaced,
/// they accumulate. On the Mac this was measured on, one copy was 177 MB.
///
/// Nothing showed them. A user who wonders where their disk went finds a file
/// beside the database with no explanation, and the report they send when they
/// ask about it does not mention it either (P3-158 is the same complaint about
/// the Windows agent, where retained backups were 7.32 GiB of a 15.3 GiB
/// footprint and the screen did count them).
public struct MigrationBackup: Equatable, Sendable {
    /// The schema version the copy was taken before leaving.
    public let fromVersion: Int
    public let sizeBytes: Int64
    public let modifiedAt: Date?
    public let url: URL

    public init(fromVersion: Int, sizeBytes: Int64, modifiedAt: Date?, url: URL) {
        self.fromVersion = fromVersion
        self.sizeBytes = sizeBytes
        self.modifiedAt = modifiedAt
        self.url = url
    }
}

public enum MigrationInventory {
    /// The copies sitting beside a database, oldest schema first.
    public static func backups(
        forDatabaseAt url: URL, fileManager: FileManager = .default
    ) -> [MigrationBackup] {
        let directory = url.deletingLastPathComponent()
        let stem = url.deletingPathExtension().lastPathComponent
        let names = (try? fileManager.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.compactMap { name -> MigrationBackup? in
            // `<stem>.pre-v<N>.sqlite`, and nothing else. The `.partial` file a
            // vacuum writes on its way is deliberately not a backup yet.
            guard name.hasPrefix("\(stem).pre-v"), name.hasSuffix(".sqlite") else { return nil }
            let middle = name.dropFirst("\(stem).pre-v".count).dropLast(".sqlite".count)
            guard let version = Int(middle) else { return nil }
            let file = directory.appendingPathComponent(name)
            let attributes = try? fileManager.attributesOfItem(atPath: file.path)
            return MigrationBackup(
                fromVersion: version,
                sizeBytes: (attributes?[.size] as? NSNumber)?.int64Value ?? 0,
                modifiedAt: attributes?[.modificationDate] as? Date,
                url: file
            )
        }
        .sorted { $0.fromVersion < $1.fromVersion }
    }

    /// The migration that was under way when the agent last stopped, if one
    /// was. Present means the previous launch did not get through it.
    public static func interrupted(forDatabaseAt url: URL) -> MigrationProgress? {
        MigrationProgressFile.read(forDatabaseAt: url)
    }
}
