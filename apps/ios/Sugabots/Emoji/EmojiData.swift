import Foundation

/// One emoji, as `@sugabots/emoji` lists it.
struct Emoji: Decodable, Hashable, Identifiable {
	/// A skin tone, as the dataset names it.
	enum SkinTone: String, CaseIterable, Decodable {
		case light
		case mediumLight = "medium-light"
		case medium
		case mediumDark = "medium-dark"
		case dark
	}

	let emoji: String
	/// Its name, as "Party popper".
	let label: String
	/// The index of its category in `EmojiDataset.categories`.
	let category: Int
	/// The Emoji version that added it, which decides whether this device can draw it.
	let version: Double
	/// Words it is found by, besides its name and shortcodes.
	let tags: [String]
	/// Its `:shortcodes:`, without the colons, lower case.
	let shortcodes: [String]
	/// The same emoji in each skin tone, for one that has them.
	let skins: [String: String]?
	/// Whether it is a country's or region's flag.
	let countryFlag: Bool?

	var id: String { emoji }

	/// The emoji in `tone`, or as it is when it has no skin tones or none is chosen.
	func inTone(_ tone: SkinTone?) -> String {
		guard let tone, let toned = skins?[tone.rawValue] else { return emoji }
		return toned
	}
}

/// The emoji the app offers, wherever one is chosen, as the web's
/// `useAvailableEmoji`: those of `@sugabots/emoji` this device can draw, in
/// their categories, read once from the copy built into the app.
struct EmojiDataset: Decodable {
	struct Category: Decodable, Hashable {
		let index: Int
		let label: String
	}

	let categories: [Category]
	/// Each skin tone's name, as "Medium-dark skin tone".
	let skinTones: [String: String]
	let emojis: [Emoji]

	/// The emoji, read the first time they are asked for.
	static let shared: EmojiDataset = {
		guard let url = Bundle.main.url(forResource: "Emoji", withExtension: "json"),
			let data = try? Data(contentsOf: url),
			let dataset = try? JSONDecoder().decode(EmojiDataset.self, from: data)
		else { return EmojiDataset(categories: [], skinTones: [:], emojis: []) }
		let newest = newestDrawableVersion
		return EmojiDataset(
			categories: dataset.categories,
			skinTones: dataset.skinTones,
			emojis: dataset.emojis.filter { $0.version <= newest }
		)
	}()

	/// The newest Emoji version this version of iOS draws; its fonts gain a version's emoji all at once.
	private static var newestDrawableVersion: Double {
		if #available(iOS 18.4, *) { return 16 }
		if #available(iOS 17.4, *) { return 15.1 }
		return 15
	}

	/// The emoji whose name or words hold `search`, best first, as the web's
	/// picker ranks them: one named so ahead of one tagged so, and one tagged
	/// with more such words ahead of one with fewer. All of them, in order, without a search.
	func searched(_ search: String) -> [Emoji] {
		let needle = search.trimmingCharacters(in: .whitespaces).lowercased()
		guard !needle.isEmpty else { return emojis }
		var scored: [(emoji: Emoji, score: Int, order: Int)] = []
		for (order, emoji) in emojis.enumerated() {
			let named = emoji.label.lowercased().contains(needle) ? 10 : 0
			let tagged = (emoji.tags + emoji.shortcodes).filter { $0.lowercased().contains(needle) }.count
			if named + tagged > 0 { scored.append((emoji, named + tagged, order)) }
		}
		scored.sort { first, second in
			first.score != second.score ? first.score > second.score : first.order < second.order
		}
		return scored.map(\.emoji)
	}

	/// The emoji `text` is, in any skin tone, ignoring variation selectors, as frimousse looks one up.
	func details(of text: String) -> Emoji? {
		Self.byText[Self.withoutSelectors(text)]
	}

	private static let byText: [String: Emoji] = {
		var found: [String: Emoji] = [:]
		for emoji in shared.emojis {
			found[withoutSelectors(emoji.emoji)] = emoji
			for toned in (emoji.skins ?? [:]).values where found[withoutSelectors(toned)] == nil {
				found[withoutSelectors(toned)] = emoji
			}
		}
		return found
	}()

	private static func withoutSelectors(_ text: String) -> String {
		String(text.unicodeScalars.filter { $0.value != 0xFE0E && $0.value != 0xFE0F }.map(Character.init))
	}
}

/// Emoji by `:shortcode:`, as `@sugabots/emoji`'s `findByShortcode` and
/// `emojiNamed`, for the composer's suggestions and completion.
enum EmojiShortcodes {
	/// How many suggestions show at once.
	private static let maxMatches = 8

	/// The emoji whose shortcodes match `query`, best first: one that is it,
	/// then one that starts with it, then one with a word that starts with it.
	static func matching(_ query: String) -> [Emoji] {
		let lowered = query.lowercased()
		var ranked: [(emoji: Emoji, rank: Int, order: Int)] = []
		for (order, emoji) in EmojiDataset.shared.emojis.enumerated() {
			let best = emoji.shortcodes.map { rank(of: $0, for: lowered) }.min() ?? noMatch
			if best < noMatch { ranked.append((emoji, best, order)) }
		}
		ranked.sort { first, second in
			first.rank != second.rank ? first.rank < second.rank : first.order < second.order
		}
		return ranked.prefix(maxMatches).map(\.emoji)
	}

	/// The emoji a whole shortcode names, as `:tada:` does.
	static func named(_ shortcode: String) -> Emoji? {
		let lowered = shortcode.lowercased()
		return EmojiDataset.shared.emojis.first { $0.shortcodes.contains(lowered) }
	}

	private static let noMatch = 3

	private static func rank(of shortcode: String, for query: String) -> Int {
		if shortcode == query { return 0 }
		if shortcode.hasPrefix(query) { return 1 }
		if shortcode.contains("_\(query)") { return 2 }
		return noMatch
	}
}

/// The emoji last chosen on this device, from the picker or by shortcode,
/// newest first, as the web's `rememberEmoji` keeps them in its browser.
enum RecentEmoji {
	private static let storageKey = "recentEmoji"
	/// As many as the picker shows in a row.
	private static let maxRecent = 9

	static var all: [String] {
		Array((UserDefaults.standard.stringArray(forKey: storageKey) ?? []).prefix(maxRecent))
	}

	/// Records `emoji` as the one chosen last; choosing one again moves it to the front.
	@discardableResult
	static func remember(_ emoji: String) -> [String] {
		let next = Array(([emoji] + all.filter { $0 != emoji }).prefix(maxRecent))
		UserDefaults.standard.set(next, forKey: storageKey)
		return next
	}
}

extension EmojiShortcodes {
	/// Records `emoji` as chosen last, as completing a shortcode does on the web.
	static func remember(_ emoji: Emoji) {
		RecentEmoji.remember(emoji.emoji)
	}
}
