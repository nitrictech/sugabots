import SwiftUI
import UIKit

/// What a bot says, as the web's `MessageMarkdown` renders it: paragraphs,
/// headings sized for a message, lists, quotes, tables that scroll, code
/// blocks with Copy, and inline code and links in the bot's own colour.
/// Mentions show as chips.
struct MessageMarkdown: View {
	let text: String
	var mentionable: [ThreadParticipant] = []
	/// The bot's palette, for its links and inline code; nil in a person's words.
	var palette: BotPalette?
	/// The body's type size.
	var size: CGFloat = 15

	var body: some View {
		let blocks = MarkdownBlocks.parse(text)
		VStack(alignment: .leading, spacing: 0) {
			ForEach(Array(blocks.enumerated()), id: \.offset) { index, block in
				view(for: block)
					.padding(.top, index == 0 ? 0 : topGap(block))
			}
		}
		.frame(maxWidth: .infinity, alignment: .leading)
	}

	private func topGap(_ block: MarkdownBlocks.Block) -> CGFloat {
		switch block {
		case .heading: 16
		case .table: 16
		default: 12
		}
	}

	@ViewBuilder private func view(for block: MarkdownBlocks.Block) -> some View {
		switch block {
		case let .paragraph(text):
			inline(text)
		case let .heading(level, text):
			inline(text, size: level == 1 ? 24 : level == 2 ? 20 : level == 3 ? 18 : size, weight: .semibold)
				.padding(.bottom, 4)
				.accessibilityAddTraits(.isHeader)
		case let .list(items, ordered, start):
			VStack(alignment: .leading, spacing: 4) {
				ForEach(Array(items.enumerated()), id: \.offset) { index, item in
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Text(ordered ? "\(start + index)." : "•")
							.font(Typeface.rubik(size))
							.foregroundStyle(Palette.mutedForeground)
							.frame(minWidth: 14, alignment: .trailing)
						VStack(alignment: .leading, spacing: 4) {
							inline(item.text)
							if !item.children.isEmpty {
								MessageMarkdown(text: item.children, mentionable: mentionable, palette: palette, size: size)
							}
						}
					}
				}
			}
			.padding(.leading, 4)
		case let .quote(text):
			MessageMarkdown(text: text, mentionable: mentionable, palette: palette, size: size)
				.foregroundStyle(Palette.mutedForeground)
				.padding(.leading, 12)
				.overlay(alignment: .leading) { Rectangle().fill(Palette.borderStrong).frame(width: 3) }
		case let .code(language, code):
			CodeBlock(language: language, code: code)
		case let .table(header, rows):
			MarkdownTable(header: header, rows: rows) { inline($0, size: 14) }
		case .rule:
			Rectangle().fill(Palette.border).frame(height: 1).padding(.vertical, 8)
		}
	}

	private func inline(_ text: String, size: CGFloat? = nil, weight: Font.Weight = .regular) -> some View {
		let size = size ?? self.size
		return inlineText(text, size: size, weight: weight)
	}

	private func inlineText(_ text: String, size: CGFloat, weight: Font.Weight) -> some View {
		Text(MarkdownInline.attributed(text, size: size, weight: weight, mentionable: mentionable, palette: palette))
			.lineSpacing(size * 0.5 - 4)
			.foregroundStyle(Palette.bodyForeground)
			.tint(palette?.mono.resolved ?? Palette.foreground)
			// Not selectable: holding a message brings up its actions, Copy among them, as Slack's do.
			.fixedSize(horizontal: false, vertical: true)
	}
}

/// A fenced code block: its language, Copy, and the code scrolling sideways.
private struct CodeBlock: View {
	let language: String?
	let code: String
	@Environment(Toaster.self) private var toaster

	var body: some View {
		VStack(alignment: .leading, spacing: 0) {
			HStack {
				Text(language ?? "")
					.font(Typeface.mono(12))
					.foregroundStyle(Palette.subtleForeground)
				Spacer()
				Button {
					UIPasteboard.general.string = code
					toaster.show("Copied")
				} label: {
					Icon(.copy, size: 14, strokeWidth: 2).frame(width: 28, height: 28)
				}
				.buttonStyle(IconPressStyle())
				.accessibilityLabel("Copy code")
			}
			.padding(.leading, 12)
			.padding(.trailing, 4)
			.padding(.top, 4)
			ScrollView(.horizontal, showsIndicators: false) {
				Text(code)
					.font(Typeface.mono(13))
					.foregroundStyle(Palette.foreground)
					.padding(.horizontal, 12)
					.padding(.bottom, 12)
					.padding(.top, 2)
			}
		}
		.background(Palette.card, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.border))
	}
}

/// A table that scrolls sideways when it is wider than the message.
private struct MarkdownTable<Cell: View>: View {
	let header: [String]
	let rows: [[String]]
	@ViewBuilder let cell: (String) -> Cell

	var body: some View {
		ScrollView(.horizontal, showsIndicators: false) {
			Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
				GridRow {
					ForEach(Array(header.enumerated()), id: \.offset) { _, title in
						cell(title).fontWeight(.semibold).padding(.horizontal, 12).padding(.vertical, 8)
					}
				}
				.background(Palette.card)
				ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
					Divider().overlay(Palette.border)
					GridRow {
						ForEach(Array(row.enumerated()), id: \.offset) { _, value in
							cell(value).padding(.horizontal, 12).padding(.vertical, 8)
						}
					}
				}
			}
			.background(Palette.background)
			.clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
			.overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.border))
		}
		.padding(8)
		.overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Palette.border))
	}
}

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
}

/// One line of markdown's inline marks as styled text: emphasis, code in the
/// bot's tint, links in its colour, and mentions as bold chips.
enum MarkdownInline {
	static func attributed(_ text: String, size: CGFloat, weight: Font.Weight, mentionable: [ThreadParticipant], palette: BotPalette?) -> AttributedString {
		let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
		var attributed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
		attributed.font = Typeface.rubik(size, weight)
		for run in attributed.runs {
			let intent = run.inlinePresentationIntent ?? []
			if intent.contains(.code) {
				attributed[run.range].font = Typeface.mono(13, .medium)
				attributed[run.range].backgroundColor = palette?.tint.resolved ?? Palette.chip
				attributed[run.range].foregroundColor = palette?.mono.resolved ?? Palette.foreground
			} else if intent.contains(.stronglyEmphasized) && intent.contains(.emphasized) {
				attributed[run.range].font = Typeface.rubik(size, .bold).italic()
			} else if intent.contains(.stronglyEmphasized) {
				attributed[run.range].font = Typeface.rubik(size, .bold)
			} else if intent.contains(.emphasized) {
				attributed[run.range].font = Typeface.rubik(size, weight).italic()
			}
			if intent.contains(.strikethrough) {
				attributed[run.range].strikethroughStyle = .single
			}
			if run.link != nil {
				attributed[run.range].foregroundColor = palette?.mono.resolved ?? Palette.foreground
				attributed[run.range].underlineStyle = .single
			}
		}
		Mentions.chip(in: &attributed, size: size, mentionable: mentionable.map(MentionTarget.participant))
		return attributed
	}
}

extension Mentions {
	/// Marks each mention of somebody in `mentionable` as a chip: a bot by
	/// its name, a person or everyone by `@handle`, in bold on the chip colour.
	static func chip(in attributed: inout AttributedString, size: CGFloat, mentionable: [MentionTarget]) {
		var chipped = AttributedString()
		var offset = 0
		for (index, part) in split(String(attributed.characters)).enumerated() {
			let written = index % 2 == 0 ? part : "@\(part)"
			let start = attributed.index(attributed.startIndex, offsetByUnicodeScalars: offset)
			let end = attributed.index(start, offsetByUnicodeScalars: written.unicodeScalars.count)
			offset += written.unicodeScalars.count
			guard index % 2 == 1, let target = target(withHandle: part, among: mentionable) else {
				chipped.append(attributed[start..<end])
				continue
			}
			let name = if case let .participant(.agent(agent)) = target { agent.name } else { "@\(target.handle)" }
			var chip = AttributedString("\u{2009}\(name)\u{2009}")
			chip.font = Typeface.rubik(size, .semibold)
			chip.foregroundColor = Palette.foreground
			chip.backgroundColor = Palette.chip
			chipped.append(chip)
		}
		attributed = chipped
	}
}
