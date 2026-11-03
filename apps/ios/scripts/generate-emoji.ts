/**
 * Writes `Sugabots/Resources/Emoji.json` from `@sugabots/emoji`, the dataset
 * the web's picker and shortcodes load, keeping only what the app reads:
 * each emoji, its name, category, Emoji version, search tags, shortcodes and
 * skin tones, and whether it is a country's flag.
 */
import dataset from "../../../packages/emoji/src/emoji.json" with { type: "json" };
import type { GeneratedFiles } from "./generated-files.ts";

export function generate(): GeneratedFiles {
	const compact = {
		categories: dataset.categories,
		skinTones: dataset.skinTones,
		emojis: dataset.emojis.map((emoji) => ({
			emoji: emoji.emoji,
			label: emoji.label,
			category: emoji.category,
			version: emoji.version,
			// The shortcodes are among the tags already; they are kept apart only to look emoji up by them.
			tags: emoji.tags.filter((tag) => !emoji.shortcodes.includes(tag)),
			shortcodes: emoji.shortcodes,
			...("skins" in emoji && emoji.skins ? { skins: emoji.skins } : {}),
			...("countryFlag" in emoji && emoji.countryFlag ? { countryFlag: true } : {}),
		})),
	};
	return { files: new Map([["Sugabots/Resources/Emoji.json", JSON.stringify(compact)]]) };
}
