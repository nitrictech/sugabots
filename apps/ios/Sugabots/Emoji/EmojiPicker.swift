import SwiftUI

/// A searchable grid of every emoji, by category, with a skin tone to pick
/// them in, and over it a row of the ones last chosen on this device, as the
/// web's `EmojiPicker` for reactions and the composer, presented as a sheet:
/// `.sheet(isPresented:) { EmojiPicker { … } }`. Typing filters the grid by
/// name, word or shortcode, and hides the recent row.
///
/// For a reaction, pass the message's emoji as `used` and `full` once it has
/// `MAX_REACTION_EMOJI_PER_MESSAGE` of them: it then says so, and only those
/// already on it can be chosen.
@MainActor
struct EmojiPicker: View {
	/// Whether the message already has as many different reactions as it may.
	var full = false
	/// The emoji already on the message, which may still be chosen while it is full.
	var used: Set<String> = []
	/// The emoji chosen, as text, with its skin tone.
	let onSelect: (String) -> Void
	@State private var search = ""
	@State private var recent = RecentEmoji.all
	@State private var tone: Emoji.SkinTone?

	/// As `MAX_REACTION_EMOJI_PER_MESSAGE` in `@sugabots/contracts`.
	static let maxReactionEmojiPerMessage = 20
	/// How many emoji each row holds, as the web's picker.
	private static let columns = 9
	/// The picker's width on the web; a phone's sheet centres it.
	private static let width: CGFloat = 332

	var body: some View {
		let dataset = EmojiDataset.shared
		let found = dataset.searched(search)
		VStack(spacing: 0) {
			SheetGrabber().padding(.bottom, 8)
			if full {
				Text("This message has \(Self.maxReactionEmojiPerMessage) different reactions, the most it can have. You can still add one of those.")
					.font(Typeface.rubik(12.5))
					.foregroundStyle(Palette.mutedForeground)
					.padding(.horizontal, 12)
					.padding(.vertical, 8)
					.frame(maxWidth: .infinity, alignment: .leading)
					.overlay(alignment: .bottom) { Rectangle().fill(Palette.borderStrong).frame(height: 1) }
			}
			VStack(spacing: 0) {
				TextField("", text: $search, prompt: Text("Search emoji").foregroundStyle(Palette.subtleForeground))
					.font(Typeface.rubik(16))
					.foregroundStyle(Palette.foreground)
					.autocorrectionDisabled()
					.textInputAutocapitalization(.never)
					.submitLabel(.done)
					.padding(.horizontal, 10)
					.frame(height: 32)
					.background(Palette.background, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
					.overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Palette.borderStrong))
					.accessibilityLabel("Search emoji")
					.padding(8)
					.padding(.bottom, -4)
				if !recent.isEmpty, search.isEmpty {
					header("Recent")
					HStack(spacing: 0) {
						ForEach(recent, id: \.self) { emoji in
							cell(emoji, label: dataset.details(of: emoji)?.label ?? emoji)
						}
						Spacer(minLength: 0)
					}
					.padding(.horizontal, 6)
				}
			}
			.padding(.bottom, 6)
			.overlay(alignment: .bottom) { Rectangle().fill(Palette.borderStrong).frame(height: 1) }
			ScrollView {
				LazyVStack(alignment: .leading, spacing: 0, pinnedViews: .sectionHeaders) {
					ForEach(dataset.categories, id: \.index) { category in
						let inCategory = found.filter { $0.category == category.index }
						if !inCategory.isEmpty {
							Section {
								ForEach(Array(stride(from: 0, to: inCategory.count, by: Self.columns)), id: \.self) { start in
									HStack(spacing: 0) {
										ForEach(inCategory[start..<min(start + Self.columns, inCategory.count)]) { emoji in
											cell(emoji.inTone(tone), label: emoji.label)
										}
										Spacer(minLength: 0)
									}
									.padding(.horizontal, 6)
								}
							} header: {
								header(category.label).background(Palette.panel)
							}
						}
					}
				}
				.padding(.bottom, 6)
			}
			.overlay {
				if found.isEmpty {
					Text(dataset.emojis.isEmpty ? "Loading…" : "No emoji found")
						.font(Typeface.rubik(12.5))
						.foregroundStyle(Palette.mutedForeground)
				}
			}
			HStack(spacing: 8) {
				Text("Pick an emoji…").font(Typeface.rubik(12.5)).foregroundStyle(Palette.subtleForeground)
				Spacer()
				skinToneSelector(dataset)
			}
			.padding(.horizontal, 10)
			.frame(height: 40)
			.overlay(alignment: .top) { Rectangle().fill(Palette.borderStrong).frame(height: 1) }
		}
		.frame(maxWidth: Self.width)
		.frame(maxWidth: .infinity)
		.background(Palette.panel.ignoresSafeArea())
		.phoneSheet(detents: [.medium, .large])
	}

	private func header(_ label: String) -> some View {
		Text(label)
			.font(Typeface.rubik(12, .semibold))
			.foregroundStyle(Palette.subtleForeground)
			.padding(.horizontal, 12)
			.padding(.top, 8)
			.padding(.bottom, 4)
			.frame(maxWidth: .infinity, alignment: .leading)
			.accessibilityAddTraits(.isHeader)
	}

	private func cell(_ emoji: String, label: String) -> some View {
		Button { choose(emoji) } label: {
			Text(emoji)
				.font(.system(size: 20))
				.frame(width: 32, height: 32)
				.contentShape(Rectangle())
		}
		.buttonStyle(EmojiCellStyle())
		.accessibilityLabel(label)
	}

	/// The skin tone the grid is drawn in, as a raised hand in it; each press takes the next.
	private func skinToneSelector(_ dataset: EmojiDataset) -> some View {
		let tones: [Emoji.SkinTone?] = [nil] + Emoji.SkinTone.allCases
		let next = tones[((tones.firstIndex(of: tone) ?? 0) + 1) % tones.count]
		let hand = dataset.details(of: "✋")?.inTone(tone) ?? "✋"
		return Button { tone = next } label: {
			Text(hand).font(.system(size: 16)).frame(width: 28, height: 28)
		}
		.buttonStyle(EmojiCellStyle())
		.accessibilityLabel("Change skin tone" + (next.flatMap { dataset.skinTones[$0.rawValue] }.map { " (\($0))" } ?? ""))
	}

	/// Whether a message with the reactions `used` may take `emoji`: once it
	/// has `maxReactionEmojiPerMessage` different ones, only one of those.
	static func admits(_ emoji: String, besides used: Set<String>) -> Bool {
		used.count < maxReactionEmojiPerMessage || used.contains(emoji)
	}

	private func choose(_ emoji: String) {
		// A full message takes only the emoji already on it.
		if full, !used.contains(emoji) { return }
		recent = RecentEmoji.remember(emoji)
		onSelect(emoji)
	}
}

/// An emoji's square, filled with the chip colour while pressed.
private struct EmojiCellStyle: ButtonStyle {
	func makeBody(configuration: Configuration) -> some View {
		configuration.label
			.background(configuration.isPressed ? Palette.chip : .clear, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
	}
}
