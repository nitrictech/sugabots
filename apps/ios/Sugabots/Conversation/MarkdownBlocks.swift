import Foundation

/// Markdown split into blocks, as the web's renderer splits GitHub's flavour of
/// it, enough of it for what bots write. Each block's words are still markdown,
/// for `inline` to read their marks, but its lines are already joined as they
/// read: a line break where markdown breaks the line, and a space elsewhere.
enum MarkdownBlocks {
	struct ListItem {
		let text: String
		/// Whether a task is done, for an item that is a task: `- [x] Done`.
		var checked: Bool?
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

	/// How far code is indented to be a block of its own without a fence.
	private static let codeIndent = 4

	static func parse(_ markdown: String) -> [Block] {
		let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
		var blocks: [Block] = []
		var index = 0
		var paragraph: [String] = []
		func closeParagraph() {
			if !paragraph.isEmpty {
				blocks.append(.paragraph(joined(paragraph)))
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
			// A line of = or - under a paragraph makes it a heading.
			if !paragraph.isEmpty, let underline = trimmed.wholeMatch(of: /(=+|-+)/) {
				blocks.append(.heading(level: underline.1.first == "=" ? 1 : 2, text: joined(paragraph)))
				paragraph = []
				index += 1
				continue
			}
			if paragraph.isEmpty, indentOf(line) >= codeIndent {
				var code: [String] = []
				while index < lines.count {
					let next = lines[index]
					if next.trimmingCharacters(in: .whitespaces).isEmpty {
						code.append("")
					} else if indentOf(next) >= codeIndent {
						code.append(String(next.dropFirst(codeIndent)))
					} else {
						break
					}
					index += 1
				}
				while code.last?.isEmpty == true { code.removeLast() }
				blocks.append(.code(language: nil, code: code.joined(separator: "\n")))
				continue
			}
			if let heading = trimmed.wholeMatch(of: /(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*/) {
				closeParagraph()
				blocks.append(.heading(level: heading.1.count, text: joined([String(heading.2 ?? "")])))
				index += 1
				continue
			}
			if isRule(trimmed) {
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
			if let header = tableHeader(at: index, in: lines) {
				closeParagraph()
				var rows: [[String]] = []
				index += 2
				while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).isEmpty, lines[index].contains("|") {
					// A row has the header's cells: any past them are dropped, and any it lacks are empty.
					let row = cells(lines[index])
					rows.append((0..<header.count).map { $0 < row.count ? row[$0] : "" })
					index += 1
				}
				blocks.append(.table(header: header, rows: rows))
				continue
			}
			// An ordered list breaks into a paragraph only when it starts at 1.
			if let first = listMarker(line), paragraph.isEmpty || !first.ordered || first.number == 1 {
				closeParagraph()
				blocks.append(list(from: &index, in: lines, startingWith: first))
				continue
			}
			paragraph.append(line)
			index += 1
		}
		closeParagraph()
		return blocks
	}

	/// The list whose first item is at `index`, and `index` moved past it. Its
	/// items share their marker's kind: a `+` after a `-` starts another list.
	private static func list(from index: inout Int, in lines: [String], startingWith first: ListMarker) -> Block {
		var items: [ListItem] = []
		func isSibling(_ marker: ListMarker) -> Bool {
			marker.ordered == first.ordered && marker.delimiter == first.delimiter && marker.indent <= first.indent
		}
		while index < lines.count, let marker = listMarker(lines[index]), isSibling(marker) {
			var text = [marker.text]
			var nested: [String] = []
			index += 1
			while index < lines.count {
				let next = lines[index]
				if next.trimmingCharacters(in: .whitespaces).isEmpty {
					// After a blank line the item goes on only with lines indented under it.
					guard let following = lines[(index + 1)...].first(where: { !$0.trimmingCharacters(in: .whitespaces).isEmpty }),
						indentOf(following) > first.indent
					else { break }
					nested.append("")
					index += 1
					continue
				}
				if let deeper = listMarker(next), deeper.indent <= first.indent { break }
				let indent = indentOf(next)
				if indent > first.indent {
					nested.append(String(next.dropFirst(min(indent, first.indent + 2))))
				} else if nested.isEmpty, !startsBlock(next) {
					// A line that isn't indented carries on the item's words.
					text.append(next)
				} else {
					break
				}
				index += 1
			}
			// Blank lines between items keep them in one list, a loose one.
			var after = index
			while after < lines.count, lines[after].trimmingCharacters(in: .whitespaces).isEmpty { after += 1 }
			if after > index, after < lines.count, let sibling = listMarker(lines[after]), isSibling(sibling) { index = after }
			var checked: Bool?
			if let task = text[0].wholeMatch(of: /\[([ xX])\]\s+(.*)/) {
				checked = task.1 != " "
				text[0] = String(task.2)
			}
			while nested.first?.isEmpty == true { nested.removeFirst() }
			items.append(ListItem(text: joined(text), checked: checked, children: nested.joined(separator: "\n")))
		}
		return .list(items: items, ordered: first.ordered, start: first.number ?? 1)
	}

	/// Lines of a paragraph as they read: each line break a space, unless two
	/// spaces or a backslash end its line, where it breaks the line. Runs of
	/// spaces read as one, as a browser draws them.
	private static func joined(_ lines: [String]) -> String {
		lines.enumerated().map { index, line in
			let hardBreak = line.hasSuffix("  ")
			let words = line.trimmingCharacters(in: .whitespaces).replacing(/[ \t]+/, with: " ")
			guard index < lines.count - 1 else { return words }
			// Foundation reads a backslash before a line break as a break of its own.
			if hardBreak || words.hasSuffix("\\") { return words + "\n" }
			return words + " "
		}.joined()
	}

	private static func isRule(_ trimmed: String) -> Bool {
		trimmed.wholeMatch(of: /([-*_])(\s*\1){2,}/) != nil
	}

	/// Whether `line` starts a block of its own, which ends the paragraph before it.
	private static func startsBlock(_ line: String) -> Bool {
		let trimmed = line.trimmingCharacters(in: .whitespaces)
		return trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") || trimmed.hasPrefix(">") || trimmed.hasPrefix("#") || isRule(trimmed)
	}

	/// The header's cells, when the line at `index` heads a table: one with a
	/// pipe, over a row of dashes with as many cells, colons marking alignment.
	private static func tableHeader(at index: Int, in lines: [String]) -> [String]? {
		guard index + 1 < lines.count, lines[index].contains("|") else { return nil }
		let delimiter = lines[index + 1].trimmingCharacters(in: .whitespaces)
		guard delimiter.wholeMatch(of: /\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?/) != nil else { return nil }
		let header = cells(lines[index])
		return cells(delimiter).count == header.count ? header : nil
	}

	/// A row's cells, split at each pipe that isn't escaped. An escaped one is
	/// left for `inline` to read as the pipe it stands for.
	private static func cells(_ row: String) -> [String] {
		var inner = Substring(row.trimmingCharacters(in: .whitespaces))
		if inner.hasPrefix("|") { inner.removeFirst() }
		if inner.hasSuffix("|"), !inner.hasSuffix("\\|") { inner.removeLast() }
		var cells: [String] = []
		var cell = ""
		var escaped = false
		for character in inner {
			if character == "|", !escaped {
				cells.append(cell)
				cell = ""
			} else {
				cell.append(character)
			}
			escaped = character == "\\" && !escaped
		}
		cells.append(cell)
		return cells.map { joined([$0]) }
	}

	/// A list item's marker: how far it is indented, a bullet's character or a
	/// number's delimiter, the number, and the words after it.
	private struct ListMarker {
		let indent: Int
		let ordered: Bool
		let delimiter: Character
		let number: Int?
		let text: String
	}

	private static func listMarker(_ line: String) -> ListMarker? {
		let indent = indentOf(line)
		let rest = line.dropFirst(indent)
		if let bullet = rest.wholeMatch(of: /([-*+])\s+(.*)/) {
			return ListMarker(indent: indent, ordered: false, delimiter: bullet.1.first ?? "-", number: nil, text: String(bullet.2))
		}
		if let numbered = rest.wholeMatch(of: /(\d{1,9})([.)])\s+(.*)/) {
			return ListMarker(indent: indent, ordered: true, delimiter: numbered.2.first ?? ".", number: Int(numbered.1), text: String(numbered.3))
		}
		return nil
	}

	private static func indentOf(_ line: String) -> Int {
		line.prefix { $0 == " " || $0 == "\t" }.count
	}

	/// A block's words with their inline marks read: emphasis, code and links as
	/// presentation intents and links, the marks themselves gone.
	static func inline(_ text: String) -> AttributedString {
		let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
		return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
	}
}
