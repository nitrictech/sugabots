import Foundation

/// Messages shortened for one line, as `messagePreview` in `@sugabots/contracts`.
enum Previews {
	/// The longest a preview runs.
	static let maxCharacters = Limits.messagePreviewCharacters

	static func message(_ content: String) -> String {
		let line = content.components(separatedBy: "\n")
			.lazy
			.map { plain($0).replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces) }
			.first { !$0.isEmpty } ?? ""
		guard line.count > maxCharacters else { return line }
		let cut = String(line.prefix(maxCharacters - 1))
		let atWord = cut.lastIndex(of: " ").map { String(cut[..<$0]) } ?? cut
		return atWord.trimmingCharacters(in: .whitespaces) + "…"
	}

	/// A message as a reply quotes it: its spoken text, without narration.
	static func quoted(_ message: Message) -> String {
		var spoken = ""
		for (index, part) in message.parts.enumerated() {
			guard case let .text(textPart) = part else { continue }
			if index + 1 < message.parts.count, case .toolCall = message.parts[index + 1] { continue }
			spoken += textPart.text
		}
		return Self.message(spoken.isEmpty ? message.content : spoken)
	}

	/// Markdown in one line written as plain text: no emphasis marks, links as their words.
	private static func plain(_ line: String) -> String {
		line
			.replacingOccurrences(of: #"!?\[([^\]]*)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
			.replacingOccurrences(of: #"^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)"#, with: "", options: .regularExpression)
			.replacingOccurrences(of: #"(\*\*|__|\*|_|~~|`)"#, with: "", options: .regularExpression)
	}
}
