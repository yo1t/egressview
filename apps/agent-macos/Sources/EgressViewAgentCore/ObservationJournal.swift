import Darwin
import Foundation

public final class ObservationJournal: @unchecked Sendable {
    public static let appGroupIdentifier = "group.com.egressview.agent"

    private let fileURL: URL
    private let archiveURL: URL
    private let lockURL: URL
    private let maximumFileSize: UInt64
    private let lock = NSLock()
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(fileURL: URL, maximumFileSize: UInt64 = 10 * 1_024 * 1_024) {
        self.fileURL = fileURL
        self.archiveURL = fileURL.appendingPathExtension("1")
        self.lockURL = fileURL.appendingPathExtension("lock")
        self.maximumFileSize = max(1_024, maximumFileSize)
        self.encoder = JSONEncoder()
        self.encoder.dateEncodingStrategy = .iso8601
        self.decoder = JSONDecoder()
        self.decoder.dateDecodingStrategy = .iso8601
    }

    public convenience init(fileManager: FileManager = .default) throws {
        guard let containerURL = fileManager.containerURL(
            forSecurityApplicationGroupIdentifier: Self.appGroupIdentifier
        ) else {
            throw ObservationJournalError.appGroupUnavailable
        }
        self.init(fileURL: containerURL.appendingPathComponent("observations.jsonl"))
    }

    public func append(_ observations: [ConnectionObservation]) throws {
        guard !observations.isEmpty else { return }
        let payload = try observations.reduce(into: Data()) { output, observation in
            output.append(try encoder.encode(observation))
            output.append(0x0A)
        }

        try lock.withLock {
            try prepareDirectory()
            try withProcessLock {
                let currentSize = (try? fileURL.resourceValues(forKeys: [.fileSizeKey]).fileSize)
                    .map(UInt64.init) ?? 0
                if currentSize > 0, currentSize + UInt64(payload.count) > maximumFileSize {
                    try rotate()
                }
                let handle = try openForAppending()
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: payload)
                try applyPrivatePermissions(to: fileURL)
            }
        }
    }

    public func latest(limit: Int = 500) throws -> [ConnectionObservation] {
        guard limit > 0 else { return [] }
        return try lock.withLock {
            try prepareDirectory()
            return try withProcessLock {
                var latestByKey: [String: ConnectionObservation] = [:]
                for url in [archiveURL, fileURL] where FileManager.default.fileExists(atPath: url.path) {
                    let data = try Data(contentsOf: url, options: .mappedIfSafe)
                    for line in data.split(separator: 0x0A) {
                        guard let observation = try? decoder.decode(ConnectionObservation.self, from: Data(line)) else {
                            continue
                        }
                    if let existing = latestByKey[observation.stableKey],
                       observation.lastObservedAt <= existing.lastObservedAt {
                        continue
                    } else {
                        latestByKey[observation.stableKey] = observation
                    }
                    }
                }
                return latestByKey.values
                    .sorted { $0.lastObservedAt > $1.lastObservedAt }
                    .prefix(limit)
                    .map { $0 }
            }
        }
    }

    private func prepareDirectory() throws {
        let directory = fileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try applyPrivatePermissions(to: directory, permissions: 0o700)
    }

    private func openForAppending() throws -> FileHandle {
        if !FileManager.default.fileExists(atPath: fileURL.path) {
            guard FileManager.default.createFile(
                atPath: fileURL.path,
                contents: nil,
                attributes: [.posixPermissions: 0o600]
            ) else {
                throw ObservationJournalError.createFailed
            }
        }
        return try FileHandle(forWritingTo: fileURL)
    }

    private func rotate() throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: archiveURL.path) {
            try fileManager.removeItem(at: archiveURL)
        }
        if fileManager.fileExists(atPath: fileURL.path) {
            try fileManager.moveItem(at: fileURL, to: archiveURL)
            try applyPrivatePermissions(to: archiveURL)
        }
    }

    private func withProcessLock<T>(_ operation: () throws -> T) throws -> T {
        let descriptor = Darwin.open(
            lockURL.path,
            O_CREAT | O_RDWR,
            S_IRUSR | S_IWUSR
        )
        guard descriptor >= 0 else {
            throw ObservationJournalError.lockFailed(errno)
        }
        defer { Darwin.close(descriptor) }
        guard flock(descriptor, LOCK_EX) == 0 else {
            throw ObservationJournalError.lockFailed(errno)
        }
        defer { flock(descriptor, LOCK_UN) }
        try applyPrivatePermissions(to: lockURL)
        return try operation()
    }

    private func applyPrivatePermissions(to url: URL, permissions: Int = 0o600) throws {
        try FileManager.default.setAttributes([.posixPermissions: permissions], ofItemAtPath: url.path)
    }
}

public enum ObservationJournalError: LocalizedError {
    case appGroupUnavailable
    case createFailed
    case lockFailed(Int32)

    public var errorDescription: String? {
        switch self {
        case .appGroupUnavailable:
            return "The EgressView App Group container is unavailable"
        case .createFailed:
            return "The local observation journal could not be created"
        case .lockFailed(let code):
            return "The local observation journal could not be locked (errno \(code))"
        }
    }
}

private extension NSLock {
    func withLock<T>(_ operation: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try operation()
    }
}
