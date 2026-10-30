import { useEffect, useState } from "react";
import { EMOJI_DATA_PATH, EMOJI_LOCALE, EMOJI_SHORTCODES } from "./emoji-data.ts";

/** An emoji and the names it is typed by between colons, as `thinking` for 🤔. */
export interface ShortcodeEmoji {
	emoji: string;
	/** The first is the one to show. */
	shortcodes: readonly string[];
}

/** How many emoji the composer offers for one shortcode being typed. */
const MAX_MATCHES = 8;

/**
 * Every emoji that has a shortcode, in the picker's order, once they have
 * loaded; until `wanted`, nothing is fetched. They load once for the page and
 * are kept, so later drafts have them at once.
 */
export function useShortcodeEmoji(wanted: boolean): readonly ShortcodeEmoji[] | undefined {
	const [loaded, setLoaded] = useState(cached);
	useEffect(() => {
		if (!wanted || loaded) return;
		let current = true;
		loadShortcodeEmoji().then(
			(emoji) => {
				if (current) setLoaded(emoji);
			},
			// Without them the draft is still written as typed, colons and all.
			() => {},
		);
		return () => {
			current = false;
		};
	}, [wanted, loaded]);
	return loaded;
}

/**
 * The emoji whose shortcodes match `query`, which is what follows the colon:
 * one named exactly so first, then those whose name starts with it, then those
 * with a word in their name that does, as `fac` finds `thinking_face`.
 */
export function findEmoji(
	all: readonly ShortcodeEmoji[],
	query: string,
): readonly ShortcodeEmoji[] {
	const lowered = query.toLowerCase();
	const ranked: { emoji: ShortcodeEmoji; rank: number }[] = [];
	for (const emoji of all) {
		const rank = Math.min(...emoji.shortcodes.map((shortcode) => matchRank(shortcode, lowered)));
		if (rank < NO_MATCH) ranked.push({ emoji, rank });
	}
	// Sorting is stable, so emoji of the same rank stay in the picker's order.
	return ranked
		.sort((a, b) => a.rank - b.rank)
		.slice(0, MAX_MATCHES)
		.map(({ emoji }) => emoji);
}

/** The emoji named exactly `shortcode`, if one is. */
export function emojiNamed(
	all: readonly ShortcodeEmoji[],
	shortcode: string,
): ShortcodeEmoji | undefined {
	const lowered = shortcode.toLowerCase();
	return all.find((emoji) => emoji.shortcodes.includes(lowered));
}

const NO_MATCH = 3;

function matchRank(shortcode: string, query: string): number {
	if (shortcode === query) return 0;
	if (shortcode.startsWith(query)) return 1;
	if (shortcode.includes(`_${query}`)) return 2;
	return NO_MATCH;
}

let cached: readonly ShortcodeEmoji[] | undefined;
let loading: Promise<readonly ShortcodeEmoji[]> | undefined;

function loadShortcodeEmoji(): Promise<readonly ShortcodeEmoji[]> {
	loading ??= fetchShortcodeEmoji().then(
		(emoji) => {
			cached = emoji;
			return emoji;
		},
		(failure: unknown) => {
			// Typing another shortcode tries again.
			loading = undefined;
			throw failure;
		},
	);
	return loading;
}

/** One emoji as Emojibase's `data.json` lists it, as far as is read here. */
interface EmojibaseEmoji {
	hexcode: string;
	emoji: string;
}

/**
 * The emoji from the picker's own data, which the browser has likely cached
 * already, named by their GitHub shortcodes, the ones Slack and GitHub
 * people know. Emojibase keys each emoji's shortcode, or list of them, by its
 * hexcode.
 */
async function fetchShortcodeEmoji(): Promise<readonly ShortcodeEmoji[]> {
	const [data, shortcodes] = await Promise.all([
		fetchJson<EmojibaseEmoji[]>(`${EMOJI_DATA_PATH}/${EMOJI_LOCALE}/data.json`),
		fetchJson<Record<string, string | string[]>>(
			`${EMOJI_DATA_PATH}/${EMOJI_LOCALE}/${EMOJI_SHORTCODES}`,
		),
	]);
	return data.flatMap(({ hexcode, emoji }) => {
		const named = shortcodes[hexcode];
		if (named === undefined) return [];
		return [{ emoji, shortcodes: typeof named === "string" ? [named] : named }];
	});
}

async function fetchJson<T>(path: string): Promise<T> {
	const response = await fetch(path);
	if (!response.ok) throw new Error(`Fetching ${path} failed with ${response.status}`);
	return response.json();
}
