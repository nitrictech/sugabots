import Foundation
import Security

/// The bearer token, kept in the Keychain and read from memory, since every request reads it.
final class TokenStore: @unchecked Sendable {
	private static let service = "ai.sugabots.app.session"

	private let account: String
	/// Guards `cached` and the Keychain item, so the two never disagree.
	private let lock = NSLock()
	private var cached: String?

	/// One token per server, so signing in to a second server keeps the first's.
	init(server: URL) {
		account = Self.account(for: server)
		cached = Self.read(account: account)
	}

	var token: String? { lock.withLock { cached } }

	/// Keeps `token`, replacing any kept before. Throws when the Keychain refuses
	/// it, when the token is not kept for the next launch either.
	func store(_ token: String) throws {
		try lock.withLock {
			try Self.write(token, account: account)
			cached = token
		}
	}

	/// Forgets the token, signing this app out of the server.
	func clear() {
		lock.withLock {
			cached = nil
			SecItemDelete(Self.query(account: account) as CFDictionary)
		}
	}

	/// The Keychain account `server`'s token is kept under: its address with
	/// its scheme and host in lowercase and no trailing slash, so
	/// `https://Example.com/api/` and `https://example.com/api` share one.
	static func account(for server: URL) -> String {
		guard var components = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return server.absoluteString }
		components.scheme = components.scheme?.lowercased()
		components.host = components.host?.lowercased()
		while components.path.hasSuffix("/") {
			components.path.removeLast()
		}
		return components.string ?? server.absoluteString
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

	/// Updates the account's item to `token`, or adds the item when there is none.
	private static func write(_ token: String, account: String) throws {
		let attributes: [String: Any] = [
			kSecValueData as String: Data(token.utf8),
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]
		let updated = SecItemUpdate(query(account: account) as CFDictionary, attributes as CFDictionary)
		if updated == errSecSuccess { return }
		guard updated == errSecItemNotFound else { throw KeychainFailure(status: updated) }
		let item = query(account: account).merging(attributes) { _, new in new }
		let added = SecItemAdd(item as CFDictionary, nil)
		guard added == errSecSuccess else { throw KeychainFailure(status: added) }
	}
}

/// The Keychain refused to keep the sign-in, with `status`, a Security framework result code.
struct KeychainFailure: LocalizedError {
	let status: OSStatus

	var errorDescription: String? { "Your sign-in could not be kept in the Keychain (error \(status))." }
}
