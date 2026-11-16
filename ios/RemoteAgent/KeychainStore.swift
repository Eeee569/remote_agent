import Foundation
import RemoteAgentCore
import Security

/// The host list — passwords and private keys included — lives in the Keychain,
/// never in plain files or in the web view's storage.
final class KeychainStore: BridgeStore {
    private let service = "remote-agent.hosts"

    private func baseQuery(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
    }

    func get(_ key: String) -> String? {
        var query = baseQuery(key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data
        else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func set(_ key: String, value: String?) {
        SecItemDelete(baseQuery(key) as CFDictionary)
        guard let data = value?.data(using: .utf8) else { return }
        var item = baseQuery(key)
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }
}
