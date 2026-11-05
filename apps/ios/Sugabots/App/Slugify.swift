import Foundation

/// The longest slug `slugify` returns, as `slugify` in `@sugabots/contracts` caps it.
private let maxSlugCharacters = 48

/// slugify returns `name` as a pod or workspace slug, as `slugify` in
/// `@sugabots/contracts` does: `Suga Team` becomes `suga-team`. A name with no
/// letter or digit in it gives an empty slug.
func slugify(_ name: String) -> String {
	let hyphens = CharacterSet(charactersIn: "-")
	let joined = name.lowercased()
		.replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression)
		.trimmingCharacters(in: hyphens)
	// Trimmed again after the cap, which can fall between a word and the hyphen after it.
	return String(joined.prefix(maxSlugCharacters)).trimmingCharacters(in: hyphens)
}
