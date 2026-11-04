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

	/// One line of markdown as the text it reads as once rendered, without its
	/// syntax, as `markdownText`. A rule reads as nothing, where Foundation draws one.
	private static func plain(_ line: String) -> String {
		guard let parsed = try? AttributedString(markdown: line) else { return line }
		return parsed.runs
			.filter { run in !(run.presentationIntent?.components.contains { $0.kind == .thematicBreak } ?? false) }
			.map { String(parsed[$0.range].characters) }
			.joined()
	}
}
