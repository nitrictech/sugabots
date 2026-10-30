import type { Emoji } from "./dataset.ts";

/** How many emoji are offered for one shortcode being typed. */
const MAX_MATCHES = 8;

/**
 * The emoji whose shortcodes match `query`, which is what follows the colon:
 * one named exactly so first, then those whose name starts with it, then those
 * with a word in their name that does, as `fac` finds `thinking_face`. Emoji
 * that match equally stay in the order given.
 */
export function findByShortcode(emojis: readonly Emoji[], query: string): Emoji[] {
	const lowered = query.toLowerCase();
	const ranked: { emoji: Emoji; rank: number }[] = [];
	for (const emoji of emojis) {
		const rank = Math.min(...emoji.shortcodes.map((shortcode) => matchRank(shortcode, lowered)));
		if (rank < NO_MATCH) ranked.push({ emoji, rank });
	}
	return ranked
		.sort((a, b) => a.rank - b.rank)
		.slice(0, MAX_MATCHES)
		.map(({ emoji }) => emoji);
}

/** The emoji named exactly `shortcode`, if one is. */
export function emojiNamed(emojis: readonly Emoji[], shortcode: string): Emoji | undefined {
	const lowered = shortcode.toLowerCase();
	return emojis.find((emoji) => emoji.shortcodes.includes(lowered));
}

const NO_MATCH = 3;

function matchRank(shortcode: string, query: string): number {
	if (shortcode === query) return 0;
	if (shortcode.startsWith(query)) return 1;
	if (shortcode.includes(`_${query}`)) return 2;
	return NO_MATCH;
}
