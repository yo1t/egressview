import Foundation
import Security

public protocol AgentAPIKeyStoring: Sendable {
    func save(_ key: String, provider: String) throws
    func load(provider: String) throws -> String?
    func delete(provider: String) throws
}

public extension AgentAPIKeyStoring {
    func loadDetached(provider: String) async throws -> String? {
        try await Task.detached(priority: .utility) { [self] in
            try load(provider: provider)
        }.value
    }

    func saveDetached(_ key: String, provider: String) async throws {
        try await Task.detached(priority: .utility) { [self] in
            try save(key, provider: provider)
        }.value
    }

    func deleteDetached(provider: String) async throws {
        try await Task.detached(priority: .utility) { [self] in
            try delete(provider: provider)
        }.value
    }
}

public struct KeychainAgentAPIKeyStore: AgentAPIKeyStoring {
    private let service: String

    public init(service: String = "com.egressview.agent.ai-api-key") {
        self.service = service
    }

    public func save(_ key: String, provider: String) throws {
        let clean = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, let data = clean.data(using: .utf8) else {
            throw AgentAPIKeyStoreError.invalidKey
        }
        let query = baseQuery(provider: provider)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess { return }
        guard updateStatus == errSecItemNotFound else {
            throw AgentAPIKeyStoreError.keychain(updateStatus)
        }
        var create = query
        attributes.forEach { create[$0.key] = $0.value }
        let createStatus = SecItemAdd(create as CFDictionary, nil)
        guard createStatus == errSecSuccess else {
            throw AgentAPIKeyStoreError.keychain(createStatus)
        }
    }

    public func load(provider: String) throws -> String? {
        var query = baseQuery(provider: provider)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw AgentAPIKeyStoreError.keychain(status) }
        guard let data = result as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else {
            throw AgentAPIKeyStoreError.invalidKey
        }
        return key
    }

    public func delete(provider: String) throws {
        let status = SecItemDelete(baseQuery(provider: provider) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw AgentAPIKeyStoreError.keychain(status)
        }
    }

    private func baseQuery(provider: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: provider,
        ]
    }
}

public enum AgentAPIKeyStoreError: Error, Equatable {
    case invalidKey
    case keychain(OSStatus)
}
