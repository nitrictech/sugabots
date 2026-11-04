import Foundation

/// Markdown split into blocks, enough of GitHub's flavour for what bots write.
enum MarkdownBlocks {
	struct ListItem {
		let text: String
		/// Lines nested under it, as markdown of their own.
		let children: String
	}

	enum Block {
		case paragraph(String)
		case heading(level: Int, text: String)
		case list(items: [ListItem], ordered: Bool, start: Int)
		case quote(String)
		case code(language: String?, code: String)
		case table(header: [String], rows: [[String]])
		case rule
	}

	static func parse(_ markdown: String) -> [Block] {
		let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
		var blocks: [Block] = []
		var index = 0
		var paragraph: [String] = []
		func closeParagraph() {
			if !paragraph.isEmpty {
				blocks.append(.paragraph(paragraph.joined(separator: "\n")))
				paragraph = []
			}
		}
		while index < lines.count {
			let line = lines[index]
			let trimmed = line.trimmingCharacters(in: .whitespaces)
			if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
				closeParagraph()
				let fence = String(trimmed.prefix(3))
				let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
				var code: [String] = []
				index += 1
				while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(fence) {
					code.append(lines[index])
					index += 1
				}
				blocks.append(.code(language: language.isEmpty ? nil : language, code: code.joined(separator: "\n")))
				index += 1
				continue
			}
			if trimmed.isEmpty {
				closeParagraph()
				index += 1
				continue
			}
			if let heading = trimmed.firstMatch(of: /^(#{1,6})\s+(.*)$/) {
				closeParagraph()
				blocks.append(.heading(level: heading.1.count, text: String(heading.2)))
				index += 1
				continue
			}
			if trimmed.wholeMatch(of: /([-*_])(\s*\1){2,}/) != nil {
				closeParagraph()
				blocks.append(.rule)
				index += 1
				continue
			}
			if trimmed.hasPrefix(">") {
				closeParagraph()
				var quoted: [String] = []
				while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix(">") {
					quoted.append(String(lines[index].trimmingCharacters(in: .whitespaces).dropFirst()).trimmingCharacters(in: .init(charactersIn: " ")))
					index += 1
				}
				blocks.append(.quote(quoted.joined(separator: "\n")))
				continue
			}
			if trimmed.hasPrefix("|"), index + 1 < lines.count, lines[index + 1].contains("-"), lines[index + 1].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
				closeParagraph()
				let header = cells(trimmed)
				var rows: [[String]] = []
				index += 2
				while index < lines.count, lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("|") {
					rows.append(cells(lines[index].trimmingCharacters(in: .whitespaces)))
					index += 1
				}
				blocks.append(.table(header: header, rows: rows))
				continue
			}
			if let first = listMarker(line) {
				closeParagraph()
				var items: [ListItem] = []
				let start = first.number ?? 1
				while index < lines.count, let marker = listMarker(lines[index]), marker.ordered == first.ordered, marker.indent <= first.indent {
					var text = marker.text
					var nested: [String] = []
					index += 1
					while index < lines.count {
						let next = lines[index]
						if next.trimmingCharacters(in: .whitespaces).isEmpty { break }
						if let deeper = listMarker(next), deeper.indent <= first.indent { _ = deeper; break }
						let indent = next.prefix { $0 == " " || $0 == "\t" }.count
						if indent > first.indent {
							nested.append(String(next.dropFirst(min(indent, first.indent + 2))))
						} else {
							text += "\n" + next.trimmingCharacters(in: .whitespaces)
						}
						index += 1
					}
					items.append(ListItem(text: text, children: nested.joined(separator: "\n")))
				}
				blocks.append(.list(items: items, ordered: first.ordered, start: start))
				continue
			}
			paragraph.append(line)
			index += 1
		}
		closeParagraph()
		return blocks
	}

	private static func cells(_ row: String) -> [String] {
		var inner = row
		if inner.hasPrefix("|") { inner.removeFirst() }
		if inner.hasSuffix("|") { inner.removeLast() }
		return inner.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
	}

	private static func listMarker(_ line: String) -> (indent: Int, ordered: Bool, number: Int?, text: String)? {
		let indent = line.prefix { $0 == " " || $0 == "\t" }.count
		let rest = line.dropFirst(indent)
		if let bullet = rest.firstMatch(of: /^[-*+]\s+(.*)$/) {
			return (indent, false, nil, String(bullet.1))
		}
		if let numbered = rest.firstMatch(of: /^(\d{1,9})[.)]\s+(.*)$/) {
			return (indent, true, Int(numbered.1), String(numbered.2))
		}
		return nil
	}

	/// A block's words with their inline marks read: emphasis, code and links as
	/// presentation intents and links, the marks themselves gone.
	static func inline(_ text: String) -> AttributedString {
		let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
		return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
	}
}
