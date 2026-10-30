import type { EmojiDataset } from "./dataset.ts";

export type { Emoji, EmojiCategory, EmojiDataset, SkinTone } from "./dataset.ts";
export { emojiNamed, findByShortcode } from "./shortcodes.ts";

/**
 * Every emoji, from the dataset generated into this package. Imported on
 * demand, so a bundler keeps it out of the code that loads first and serves
 * it as a file of its own that the browser caches.
 */
export async function loadEmojiDataset(): Promise<EmojiDataset> {
	// No `with { type: "json" }`: Vite then serves the file as it is, which the browser refuses to import.
	const { default: dataset } = await import("./emoji.json");
	return dataset as EmojiDataset;
}
