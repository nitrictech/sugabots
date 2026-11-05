import SwiftUI
import UIKit

/// The composer's text, as the web's `MentionEditor`: plain text with
/// `@handle` for a mention, but each finished mention of somebody it knows
/// drawn as a chip, their face and name, kept whole and removed with one
/// Backspace. A mention is finished once whitespace follows it, so one still
/// being typed stays text for the mention menu to complete.
struct MentionEditor: UIViewRepresentable {
	@Binding var text: String
	@Binding var isFocused: Bool
	let mentionable: [MentionTarget]
	/// The longest a draft may run: the longest message the API takes.
	var maxLength = Limits.messageMaxLength
	/// How many lines it grows to before it scrolls.
	var maxLines = 8
	/// Told where, in the window's points, each edit leaves the caret, for faces that watch typing.
	var typed: (CGPoint) -> Void = { _ in }

	private static let font = UIFont(name: "Rubik", size: 16) ?? .systemFont(ofSize: 16)

	func makeCoordinator() -> Coordinator { Coordinator(self) }

	func makeUIView(context: Context) -> UITextView {
		let view = UITextView()
		view.delegate = context.coordinator
		view.font = Self.font
		view.textColor = UIColor(Palette.foreground)
		view.backgroundColor = .clear
		view.textContainerInset = UIEdgeInsets(top: 8, left: 0, bottom: 8, right: 0)
		view.textContainer.lineFragmentPadding = 4
		view.isScrollEnabled = false
		view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
		view.autocorrectionType = .default
		view.typingAttributes = Coordinator.plainAttributes
		context.coordinator.render(text, in: view, caret: text.utf16.count)
		// The chips are images drawn in one appearance, so they're drawn again when it changes.
		view.registerForTraitChanges([UITraitUserInterfaceStyle.self]) { [coordinator = context.coordinator] (view: UITextView, _) in
			let plain = Coordinator.plainText(of: view.attributedText)
			coordinator.render(plain, in: view, caret: Coordinator.plainOffset(of: view.attributedText, at: view.selectedRange.location))
		}
		return view
	}

	func updateUIView(_ view: UITextView, context: Context) {
		context.coordinator.parent = self
		if Coordinator.plainText(of: view.attributedText) != text {
			context.coordinator.render(text, in: view, caret: text.utf16.count)
		}
		if isFocused, !view.isFirstResponder {
			DispatchQueue.main.async { view.becomeFirstResponder() }
		} else if !isFocused, view.isFirstResponder {
			DispatchQueue.main.async { view.resignFirstResponder() }
		}
	}

	func sizeThatFits(_ proposal: ProposedViewSize, uiView view: UITextView, context _: Context) -> CGSize? {
		let width = proposal.width ?? 280
		let fitting = view.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
		let lineHeight = Self.font.lineHeight
		let most = lineHeight * CGFloat(maxLines) + view.textContainerInset.top + view.textContainerInset.bottom
		view.isScrollEnabled = fitting.height > most
		return CGSize(width: width, height: min(fitting.height, most))
	}

	@MainActor
	final class Coordinator: NSObject, UITextViewDelegate {
		var parent: MentionEditor

		static let plainAttributes: [NSAttributedString.Key: Any] = [
			.font: MentionEditor.font,
			.foregroundColor: UIColor(Palette.foreground),
		]

		init(_ parent: MentionEditor) {
			self.parent = parent
		}

		func textViewDidBeginEditing(_: UITextView) {
			if !parent.isFocused { parent.isFocused = true }
		}

		func textViewDidEndEditing(_: UITextView) {
			if parent.isFocused { parent.isFocused = false }
		}

		func textView(_ view: UITextView, shouldChangeTextIn range: NSRange, replacementText replacement: String) -> Bool {
			let current = Self.plainText(of: view.attributedText).utf16.count
			let removed = Self.plainLength(of: view.attributedText, in: range)
			return current - removed + replacement.utf16.count <= parent.maxLength
		}

		func textViewDidChange(_ view: UITextView) {
			let plain = Self.plainText(of: view.attributedText)
			let caret = Self.plainOffset(of: view.attributedText, at: view.selectedRange.location)
			parent.text = plain
			parent.typed(Self.caretPoint(in: view))
			// Draw any mention finished by this edit as a chip.
			if Self.segments(of: plain, mentionable: parent.mentionable).contains(where: \.isMention) {
				render(plain, in: view, caret: caret)
			}
		}

		/// Where the caret is, in the window's points: its left edge, halfway down, as the web's `typingPoint`; else the middle of the field.
		static func caretPoint(in view: UITextView) -> CGPoint {
			guard let caret = view.selectedTextRange?.end else {
				let field = view.convert(view.bounds, to: nil)
				return CGPoint(x: field.midX, y: field.midY)
			}
			let rect = view.convert(view.caretRect(for: caret), to: nil)
			return CGPoint(x: rect.minX, y: rect.midY)
		}

		/// Draws `plain` with its finished mentions as chips, and puts the caret back where it was in the text.
		func render(_ plain: String, in view: UITextView, caret: Int) {
			let rendered = NSMutableAttributedString()
			var location = 0
			var caretLocation = 0
			var placed = false
			for segment in Self.segments(of: plain, mentionable: parent.mentionable) {
				let length = segment.text.utf16.count
				if !placed, caret <= location + length {
					caretLocation = rendered.length + (segment.isMention ? (caret == location ? 0 : 1) : caret - location)
					placed = true
				}
				if let target = segment.target {
					rendered.append(Self.chip(for: target, handle: segment.text, traits: view.traitCollection))
				} else {
					rendered.append(NSAttributedString(string: segment.text, attributes: Self.plainAttributes))
				}
				location += length
			}
			if !placed { caretLocation = rendered.length }
			view.attributedText = rendered
			view.typingAttributes = Self.plainAttributes
			view.selectedRange = NSRange(location: min(caretLocation, rendered.length), length: 0)
			view.invalidateIntrinsicContentSize()
		}

		// MARK: Text and chips

		struct Segment {
			let text: String
			var target: MentionTarget?
			var isMention: Bool { target != nil }
		}

		/// `plain` split around its finished mentions of somebody in `mentionable`.
		static func segments(of plain: String, mentionable: [MentionTarget]) -> [Segment] {
			var segments: [Segment] = []
			var rest = plain[...]
			while let match = rest.firstMatch(of: Mentions.finished) {
				let before = rest[..<match.2.startIndex]
				guard let target = Mentions.target(withHandle: String(match.2.dropFirst()), among: mentionable) else {
					segments.append(Segment(text: String(rest[..<match.2.endIndex])))
					rest = rest[match.2.endIndex...]
					continue
				}
				if !before.isEmpty { segments.append(Segment(text: String(before))) }
				segments.append(Segment(text: String(match.2), target: target))
				rest = rest[match.2.endIndex...]
			}
			if !rest.isEmpty { segments.append(Segment(text: String(rest))) }
			return segments
		}

		/// The draft as text, each chip as the `@handle` it stands for.
		static func plainText(of attributed: NSAttributedString) -> String {
			var plain = ""
			attributed.enumerateAttributes(in: NSRange(location: 0, length: attributed.length)) { attributes, range, _ in
				if let handle = attributes[.mentionHandle] as? String {
					plain += handle
				} else {
					plain += (attributed.string as NSString).substring(with: range)
				}
			}
			return plain
		}

		/// Where `location` in the drawn text falls in the plain text.
		static func plainOffset(of attributed: NSAttributedString, at location: Int) -> Int {
			plainLength(of: attributed, in: NSRange(location: 0, length: min(location, attributed.length)))
		}

		static func plainLength(of attributed: NSAttributedString, in range: NSRange) -> Int {
			var length = 0
			attributed.enumerateAttributes(in: range) { attributes, part, _ in
				length += (attributes[.mentionHandle] as? String)?.utf16.count ?? part.length
			}
			return length
		}

		/// A mention as a chip: a bot's face and name, or a person's or everyone's `@handle`, on
		/// the chip colour, drawn in the appearance of the text it sits in. That is
		/// the theme chosen on You, which needn't be the device's, so `traits` are
		/// the text view's rather than whatever traits are current.
		static func chip(for target: MentionTarget, handle: String, traits: UITraitCollection) -> NSAttributedString {
			let scheme: ColorScheme = traits.userInterfaceStyle == .dark ? .dark : .light
			let renderer = ImageRenderer(content: MentionChipImage(target: target).environment(\.colorScheme, scheme))
			renderer.scale = traits.displayScale
			let attachment = NSTextAttachment()
			var drawn: UIImage?
			traits.performAsCurrent { drawn = renderer.uiImage }
			if let image = drawn {
				attachment.image = image
				// Sat on the text's baseline, as the web's `align-[-0.15em]`.
				attachment.bounds = CGRect(x: 0, y: font.descender + 1, width: image.size.width, height: image.size.height)
			}
			let chip = NSMutableAttributedString(attachment: attachment)
			chip.addAttributes([.mentionHandle: handle, .font: font], range: NSRange(location: 0, length: chip.length))
			return chip
		}
	}
}

extension NSAttributedString.Key {
	/// The `@handle` a mention chip stands for in the draft's text.
	static let mentionHandle = NSAttributedString.Key("sugabotsMentionHandle")
}

/// A mention chip as the web's `MentionChip` draws it in the composer.
private struct MentionChipImage: View {
	let target: MentionTarget

	var body: some View {
		HStack(spacing: 4) {
			if case let .participant(.agent(agent)) = target {
				BotFace(look: agent.look, size: 14)
				Text(agent.name)
			} else {
				Text("@\(target.handle)")
			}
		}
		.font(Typeface.rubik(16, .semibold))
		.foregroundStyle(Palette.foreground)
		.padding(.horizontal, 4)
		.padding(.vertical, 1)
		.background(Palette.chip, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
		.padding(.horizontal, 1)
	}
}
