import CryptoKit
import Foundation

/// A person's initials for their avatar, as the web's `initials`: the first and
/// last names' first letters, or a single name's first two.
enum Initials {
	static func of(_ name: String) -> String {
		let parts = name.split(whereSeparator: \.isWhitespace)
		guard let first = parts.first else { return "?" }
		let last = parts.count > 1 ? parts.last : nil
		return (last.map { String(first.prefix(1)) + String($0.prefix(1)) } ?? String(first.prefix(2))).uppercased()
	}
}

/// Gravatar's address for an email, as `gravatarUrl` in the web app's `ui/avatar.tsx` builds it.
enum Gravatar {
	/// Drawn at three times its size, so it stays sharp on every iPhone screen.
	private static let pixelsPerPoint: CGFloat = 3

	/// Answers 404 when the address has no Gravatar, rather than a generated placeholder.
	static func url(for email: String, points: CGFloat) -> URL {
		let normalized = email.trimmingCharacters(in: .whitespaces).lowercased()
		let hash = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
		return URL(string: "https://gravatar.com/avatar/\(hash)?s=\(Int(points * pixelsPerPoint))&d=404")!
	}
}
