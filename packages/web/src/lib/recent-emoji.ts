import { useState } from "react";

const STORAGE_KEY = "sugabots-recent-emoji";

/** As many as the picker shows in a row. */
const MAX_RECENT = 9;

/**
 * The emoji last chosen in this browser, from the picker or by shortcode,
 * newest first, kept in localStorage so they last between visits. Choosing
 * one again moves it to the front. Without storage there are none.
 */
export function useRecentEmoji(): [readonly string[], (emoji: string) => void] {
	const [recent, setRecent] = useState<readonly string[]>(read);
	function remember(emoji: string) {
		setRecent(rememberEmoji(emoji));
	}
	return [recent, remember];
}

/** Records `emoji` as the one chosen last, and gives the recent emoji with it. */
export function rememberEmoji(emoji: string): readonly string[] {
	const next = [emoji, ...read().filter((used) => used !== emoji)].slice(0, MAX_RECENT);
	write(next);
	return next;
}

function read(): string[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(stored)
			? stored.filter((emoji) => typeof emoji === "string").slice(0, MAX_RECENT)
			: [];
	} catch {
		return [];
	}
}

function write(recent: readonly string[]): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(recent));
	} catch {
		// Storage can be off. The picker then has no recent emoji to show.
	}
}
