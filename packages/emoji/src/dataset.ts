/**
 * The app's emoji: every emoji Emojibase lists for English, with the name,
 * category, search tags and skin tones the picker shows, and the shortcodes
 * typed between colons, as `thinking` for 🤔. The shape is the one Frimousse,
 * the picker's library, reads, so the picker takes it as it is.
 */
export interface EmojiDataset {
	categories: EmojiCategory[];
	/** The name of each skin tone, as "Medium-dark skin tone". */
	skinTones: Record<SkinTone, string>;
	/** In the picker's order. */
	emojis: Emoji[];
}

export interface EmojiCategory {
	/** What an emoji's `category` refers to, which is also the category's place in the picker. */
	index: number;
	label: string;
}

export type SkinTone = "light" | "medium-light" | "medium" | "medium-dark" | "dark";

export interface Emoji {
	emoji: string;
	/** As "Thinking face". */
	label: string;
	category: number;
	/** The Emoji version that added it, so a browser whose fonts predate it can leave it out. */
	version: number;
	/** What searching finds it by, besides its label, its shortcodes among them. */
	tags: string[];
	/** The names it is typed by between colons, the one to show first. Most emoji have one; some have none. */
	shortcodes: string[];
	skins?: Record<SkinTone, string>;
	/** One of the flags of a country or region, which Windows draws as two letters. */
	countryFlag?: true;
	/** The same emoji with a different skin tone for each person in it, as 🧑🏻‍🤝‍🧑🏿, which names it by this one. */
	aliases?: string[];
}

/** One emoji as Emojibase's `data.json` lists it, as far as is read here. */
export interface EmojibaseEmoji {
	hexcode: string;
	emoji: string;
	label: string;
	/** Absent for the skin tone modifiers and other components, which are not offered. */
	group?: number;
	subgroup?: number;
	version: number;
	tags?: string[];
	skins?: { emoji: string; tone?: number | number[] }[];
}

/** Emojibase's `messages.json`, as far as is read here. */
export interface EmojibaseMessages {
	groups: { key: string; message: string; order: number }[];
	subgroups: { key: string; message: string; order: number }[];
	skinTones: { key: string; message: string }[];
}

/** Emojibase's shortcodes, one or several for each emoji, keyed by its hexcode. */
export type EmojibaseShortcodes = Record<string, string | string[]>;

/** Emojibase numbers the skin tones from 1, lightest first. */
const SKIN_TONES: readonly SkinTone[] = ["light", "medium-light", "medium", "medium-dark", "dark"];

/** The groups that hold the parts emoji are made of, such as the skin tone modifiers, rather than emoji to offer. */
const COMPONENT_GROUP = "component";
const FLAG_SUBGROUPS = ["country-flag", "subdivision-flag"];

/** Builds the app's emoji from Emojibase's emoji, their names and their shortcodes. */
export function buildEmojiDataset(
	emojibase: readonly EmojibaseEmoji[],
	messages: EmojibaseMessages,
	shortcodes: EmojibaseShortcodes,
): EmojiDataset {
	const componentGroups = new Set(
		messages.groups.filter(({ key }) => key === COMPONENT_GROUP).map(({ order }) => order),
	);
	const flagSubgroups = new Set(
		messages.subgroups.filter(({ key }) => FLAG_SUBGROUPS.includes(key)).map(({ order }) => order),
	);
	const categories = messages.groups
		.filter(({ order }) => !componentGroups.has(order))
		.map(({ order, message }) => ({ index: order, label: capitalize(message) }));
	const skinTones = Object.fromEntries(
		messages.skinTones.map(({ key, message }) => [key, capitalize(message)]),
	) as Record<SkinTone, string>;
	const emojis = emojibase.flatMap((entry): Emoji[] => {
		if (entry.group === undefined || componentGroups.has(entry.group)) return [];
		const named = shortcodes[entry.hexcode] ?? [];
		const entryShortcodes = typeof named === "string" ? [named] : named;
		const tags = entry.tags ?? [];
		const emoji: Emoji = {
			emoji: entry.emoji,
			label: capitalize(entry.label),
			category: entry.group,
			version: entry.version,
			tags: [...tags, ...entryShortcodes.filter((shortcode) => !tags.includes(shortcode))],
			shortcodes: entryShortcodes,
		};
		const skins = skinsOf(entry);
		if (skins) emoji.skins = skins;
		if (entry.subgroup !== undefined && flagSubgroups.has(entry.subgroup)) emoji.countryFlag = true;
		const aliases = (entry.skins ?? [])
			.filter(({ tone }) => Array.isArray(tone))
			.map((skin) => skin.emoji);
		if (aliases.length > 0) emoji.aliases = aliases;
		return [emoji];
	});
	return { categories, skinTones, emojis };
}

/** The emoji in each single skin tone, when it has them. */
function skinsOf(entry: EmojibaseEmoji): Record<SkinTone, string> | undefined {
	const toned = (entry.skins ?? []).flatMap(({ emoji, tone }) => {
		const skinTone = typeof tone === "number" ? SKIN_TONES[tone - 1] : undefined;
		return skinTone ? [[skinTone, emoji] as const] : [];
	});
	return toned.length > 0 ? (Object.fromEntries(toned) as Record<SkinTone, string>) : undefined;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
