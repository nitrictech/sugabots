import Foundation

/// An address an invitation could not go to, and why.
struct InviteFailure {
	let email: String
	let reason: String
}

/// What's typed into an invite, split at spaces, commas and semicolons, once
/// each in the order given. Members sends every entry, so the server says which
/// aren't addresses, as the web's Members page does.
func inviteEntries(in text: String) -> [String] {
	var seen = Set<String>()
	return text.split(whereSeparator: { $0.isWhitespace || $0 == "," || $0 == ";" })
		.map(String.init)
		.filter { seen.insert($0).inserted }
}

/// The entries that look like an address (`LOOKS_LIKE_EMAIL`), as the web's
/// setup invite step keeps them.
func emailAddresses(in text: String) -> [String] {
	inviteEntries(in: text).filter { $0.range(of: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$", options: .regularExpression) != nil }
}
