import { useState } from "react";

const STORAGE_KEY = "sugabots-recent-emoji";

/**
 * The emoji last chosen in this browser's picker, newest first, up to `limit`,
 * kept in localStorage so they last between visits. Choosing one again moves
 * it to the front. Without storage there are none.
 */
export function useRecentEmoji(limit: number): [readonly string[], (emoji: string) => void] {
	const [recent, setRecent] = useState(() => read().slice(0, limit));
	function remember(emoji: string) {
		const next = [emoji, ...recent.filter((used) => used !== emoji)].slice(0, limit);
		write(next);
		setRecent(next);
	}
	return [recent, remember];
}

function read(): string[] {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return Array.isArray(stored) ? stored.filter((emoji) => typeof emoji === "string") : [];
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
