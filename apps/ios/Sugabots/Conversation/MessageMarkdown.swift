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
				inline(text, size: headingSize(level: level), weight: .semibold)
				.padding(.bottom, 4)
				.accessibilityAddTraits(.isHeader)
		case let .list(items, ordered, start):
			VStack(alignment: .leading, spacing: 4) {
				ForEach(Array(items.enumerated()), id: \.offset) { index, item in
					HStack(alignment: .firstTextBaseline, spacing: 8) {
						Group {
							if let checked = item.checked {
								Image(systemName: checked ? "checkmark.square.fill" : "square")
									.font(.system(size: size * 0.9))
									.accessibilityLabel(checked ? "Done" : "Not done")
							} else {
								Text(ordered ? "\(start + index)." : "•").font(Typeface.rubik(size))
							}
						}
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

	/// The type size of a heading at `level`: three sizes for a message, then the body's.
	private func headingSize(level: Int) -> CGFloat {
		switch level {
		case 1: HeadingSize.first
		case 2: HeadingSize.second
		case 3: HeadingSize.third
		default: size
		}
	}

	private enum HeadingSize {
		static let first: CGFloat = 24
		static let second: CGFloat = 20
		static let third: CGFloat = 18
	}

	/// One line of `text` with its inline marks, at `size`, the body's size when nil.
	private func inline(_ text: String, size: CGFloat? = nil, weight: Font.Weight = .regular) -> some View {
		let size = size ?? self.size
		return Text(MarkdownInline.attributed(text, size: size, weight: weight, mentionable: mentionable, palette: palette))
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

/// One line of markdown's inline marks as styled text: emphasis, code in the
/// bot's tint, links in its colour, and mentions as bold chips.
enum MarkdownInline {
	static func attributed(_ text: String, size: CGFloat, weight: Font.Weight, mentionable: [ThreadParticipant], palette: BotPalette?) -> AttributedString {
		var attributed = MarkdownBlocks.inline(text)
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
		for piece in pieces(of: String(attributed.characters)) {
			let written = piece.written
			let start = attributed.index(attributed.startIndex, offsetByUnicodeScalars: offset)
			let end = attributed.index(start, offsetByUnicodeScalars: written.unicodeScalars.count)
			offset += written.unicodeScalars.count
			guard case let .mention(handle) = piece, let target = target(withHandle: handle, among: mentionable) else {
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
