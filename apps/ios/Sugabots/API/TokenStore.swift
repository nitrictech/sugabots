import Foundation
import Security

/// The bearer token, kept in the Keychain and read from memory, since every request reads it.
final class TokenStore: @unchecked Sendable {
	private static let service = "ai.sugabots.app.session"

	private let account: String
	private let lock = NSLock()
	private var cached: String?

	/// One token per server, so signing in to a second server keeps the first's.
	init(server: URL) {
		account = server.absoluteString
		cached = Self.read(account: account)
	}

	var token: String? {
		get { lock.withLock { cached } }
		set {
			lock.withLock { cached = newValue }
			if let newValue {
				Self.write(newValue, account: account)
			} else {
				Self.delete(account: account)
			}
		}
	}

	private static func query(account: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: account,
		]
	}

	private static func read(account: String) -> String? {
		var query = query(account: account)
		query[kSecReturnData as String] = true
		query[kSecMatchLimit as String] = kSecMatchLimitOne
		var result: CFTypeRef?
		guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
		return String(data: data, encoding: .utf8)
	}

	private static func write(_ token: String, account: String) {
		delete(account: account)
		var item = query(account: account)
		item[kSecValueData as String] = Data(token.utf8)
		item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		SecItemAdd(item as CFDictionary, nil)
	}

	private static func delete(account: String) {
		SecItemDelete(query(account: account) as CFDictionary)
	}
}
