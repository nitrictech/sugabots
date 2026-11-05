import Foundation

/// Lists of names and counts, as the web's `name-list.ts` writes them.
enum Names {
	/// The most names written out; the rest are counted as "others".
	private static let maxNamed = 3

	/// `Jay Yu`, `Jay Yu and Priya Kaur`, `Jay, Priya and Sam`, or `Jay, Priya and 3 others`.
	static func list(_ names: [String]) -> String {
		guard names.count > 1, let last = names.last else { return names.first ?? "" }
		guard names.count > maxNamed else { return names.dropLast().joined(separator: ", ") + " and " + last }
		let named = names.prefix(maxNamed - 1)
		return named.joined(separator: ", ") + " and \(names.count - named.count) others"
	}

	/// `1 reply`, `3 replies`.
	static func count(_ amount: Int, _ one: String, _ many: String) -> String {
		"\(amount) \(amount == 1 ? one : many)"
	}
}
