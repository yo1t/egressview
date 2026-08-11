import Foundation
import Security

public struct AgentCredential: Codable, Equatable, Sendable, CustomStringConvertible {
    public let hubURL: URL
    public let agentID: UUID
    public let token: String
    public let enrolledAt: Date

    public init(hubURL: URL, agentID: UUID, token: String, enrolledAt: Date = Date()) {
        self.hubURL = hubURL
        self.agentID = agentID
        self.token = token
        self.enrolledAt = enrolledAt
    }

    public var description: String {
        "AgentCredential(hubURL: \(hubURL), agentID: \(agentID), token: <redacted>)"
    }
}

public protocol AgentCredentialStoring: Sendable {
    func save(_ credential: AgentCredential) throws
    func load() throws -> AgentCredential?
    func delete() throws
}

public enum AgentCredentialStoreError: Error, Equatable {
    case encodingFailed
    case decodingFailed
    case keychain(OSStatus)
}

public struct KeychainAgentCredentialStore: AgentCredentialStoring {
    private let service: String
    private let account: String

    public init(
        service: String = "com.egressview.agent.hub-credential",
        account: String = "active-hub"
    ) {
        self.service = service
        self.account = account
    }

    public func save(_ credential: AgentCredential) throws {
        guard let data = try? JSONEncoder().encode(credential) else {
            throw AgentCredentialStoreError.encodingFailed
        }
        let query = baseQuery()
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecSuccess { return }
        if status != errSecItemNotFound {
            throw AgentCredentialStoreError.keychain(status)
        }

        var create = query
        attributes.forEach { create[$0.key] = $0.value }
        let createStatus = SecItemAdd(create as CFDictionary, nil)
        guard createStatus == errSecSuccess else {
            throw AgentCredentialStoreError.keychain(createStatus)
        }
    }

    public func load() throws -> AgentCredential? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw AgentCredentialStoreError.keychain(status)
        }
        guard let data = result as? Data,
              let credential = try? JSONDecoder().decode(AgentCredential.self, from: data) else {
            throw AgentCredentialStoreError.decodingFailed
        }
        return credential
    }

    public func delete() throws {
        let status = SecItemDelete(baseQuery() as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AgentCredentialStoreError.keychain(status)
        }
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
    }
}
