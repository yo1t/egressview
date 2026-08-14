import CryptoKit
import Foundation

public protocol AgentUpdateDownloadTransport: Sendable {
    /// Returns a file on disk plus the response. The file is the caller's to
    /// move or delete.
    func download(_ request: URLRequest) async throws -> (URL, HTTPURLResponse)
}

public struct URLSessionAgentUpdateDownloadTransport: AgentUpdateDownloadTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 300) {
        session = makeAgentEphemeralSession(timeout: timeout)
    }

    public func download(_ request: URLRequest) async throws -> (URL, HTTPURLResponse) {
        let (temporary, response) = try await session.download(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AgentUpdateError.transport("not an HTTP response")
        }
        // URLSession deletes its temporary file when this call returns, so take
        // a copy the caller can keep.
        let kept = FileManager.default.temporaryDirectory
            .appendingPathComponent("egressview-update-\(UUID().uuidString)")
        try FileManager.default.moveItem(at: temporary, to: kept)
        return (kept, response)
    }
}

public enum AgentUpdateDownloadError: Error, Equatable {
    case insecureURL
    case httpStatus(Int)
    case sizeMismatch(expected: Int, actual: Int)
    case checksumMismatch(expected: String, actual: String)
    case malformedChecksum(String)
}

/// Downloads a package named by an already-verified manifest.
///
/// The manifest signature is what makes the hash trustworthy, so this type
/// takes an `AgentUpdatePackage` that came out of `AgentUpdateChecker` and
/// treats its `sha256` as authoritative. Order matters: **the file is checked
/// before it is handed to anyone**, and a mismatch deletes it rather than
/// leaving an installable artefact on disk.
public struct AgentUpdateDownloader: Sendable {
    private let transport: any AgentUpdateDownloadTransport
    private let fileManager: FileManager

    public init(
        transport: any AgentUpdateDownloadTransport = URLSessionAgentUpdateDownloadTransport(),
        fileManager: FileManager = .default
    ) {
        self.transport = transport
        self.fileManager = fileManager
    }

    public func download(_ package: AgentUpdatePackage, userAgent: String) async throws -> URL {
        guard package.url.scheme == "https" else { throw AgentUpdateDownloadError.insecureURL }
        let expected = package.sha256.lowercased()
        guard expected.count == 64, expected.allSatisfy(\.isHexDigit) else {
            throw AgentUpdateDownloadError.malformedChecksum(package.sha256)
        }

        var request = URLRequest(url: package.url)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.httpShouldHandleCookies = false

        let (file, response) = try await transport.download(request)
        var keep = false
        defer { if !keep { try? fileManager.removeItem(at: file) } }

        guard response.statusCode == 200 else {
            throw AgentUpdateDownloadError.httpStatus(response.statusCode)
        }

        // Check the size first: it is free, and it catches a truncated transfer
        // before hashing a large file.
        let actualSize = (try fileManager.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? -1
        guard actualSize == package.sizeBytes else {
            throw AgentUpdateDownloadError.sizeMismatch(expected: package.sizeBytes, actual: actualSize)
        }

        let actual = try Self.sha256Hex(of: file)
        guard actual == expected else {
            throw AgentUpdateDownloadError.checksumMismatch(expected: expected, actual: actual)
        }

        keep = true
        return file
    }

    /// Streamed so that package size never dictates memory use.
    static func sha256Hex(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}
