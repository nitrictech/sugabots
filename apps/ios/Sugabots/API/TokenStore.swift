import Foundation
import Security

/// The bearer token, kept in the Keychain and read from memory, since every request reads it.
final class TokenStore: @unchecked Sendable {
	private static let service = "ai.sugabots.app.session"

	/// Where the token is kept, or nil for one held only in memory.
	private let account: String?
	private let lock = NSLock()
	private var cached: String?

	/// One token per server, so signing in to a second server keeps the first's.
	init(server: URL) {
		account = server.absoluteString
		cached = Self.read(account: server.absoluteString)
	}

	/// `token`, kept only in memory, as for finishing a sign-out after another account signed in.
	init(holding token: String) {
		account = nil
		cached = token
	}

	var token: String? {
		get { lock.withLock { cached } }
		set {
			lock.withLock { cached = newValue }
			guard let account else { return }
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

/// Sign-outs that didn't reach the server, as when the phone was offline,
/// kept in the Keychain and tried again until one does: until it does, the
/// session goes on, and pushes the person's notifications to this phone.
enum PendingSignOuts {
	private static let service = "ai.sugabots.app.pendingSignOut"

	/// Keeps `token`, of a session on the API at `server`, to sign out later.
	static func add(token: String, server: URL) {
		var item = query(token: token)
		item[kSecValueData as String] = Data(server.absoluteString.utf8)
		item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
		SecItemAdd(item as CFDictionary, nil)
	}

	/// Signs out each kept session, forgetting those the server has ended.
	static func retry() async {
		for (token, server) in all() {
			let client = APIClient(baseURL: server, tokens: TokenStore(holding: token))
			do {
				try await client.notifications.unregisterDevice()
				await client.signOut()
			} catch let failure as APIFailure where failure.isUnauthorized {
				// Ended already, by expiring or from another device.
			} catch {
				continue
			}
			SecItemDelete(query(token: token) as CFDictionary)
		}
	}

	private static func all() -> [(token: String, server: URL)] {
		let search: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecReturnAttributes as String: true,
			kSecReturnData as String: true,
			kSecMatchLimit as String: kSecMatchLimitAll,
		]
		var result: CFTypeRef?
		guard SecItemCopyMatching(search as CFDictionary, &result) == errSecSuccess, let items = result as? [[String: Any]] else { return [] }
		return items.compactMap { item in
			guard let token = item[kSecAttrAccount as String] as? String,
				let data = item[kSecValueData as String] as? Data,
				let server = URL(string: String(decoding: data, as: UTF8.self))
			else { return nil }
			return (token, server)
		}
	}

	private static func query(token: String) -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrAccount as String: token,
		]
	}
}
