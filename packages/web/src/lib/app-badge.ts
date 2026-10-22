import { useEffect } from "react";
import { matchesMedia } from "./media.ts";

/**
 * Shows `count` outside the page: on the icon of Sugabots installed as an
 * app, and in the title. Nothing shows while it is zero. The title goes back
 * as it was when the count goes, and the icon is cleared when the caller
 * unmounts.
 */
export function useAppBadge(count: number) {
	useEffect(() => {
		// Sets the icon straight to the new count: clearing it first, between two counts, would flicker.
		showOnIcon(count);
		if (count === 0) return;
		return markTitle(`(${count})`);
	}, [count]);
	useEffect(() => () => showOnIcon(0), []);
}

/**
 * Shows `count` on the installed app's icon. Zero clears it, including a
 * badge from before a reload, which the icon keeps.
 */
function showOnIcon(count: number) {
	if (!("setAppBadge" in navigator)) return;
	const showing = count > 0 ? navigator.setAppBadge(count) : navigator.clearAppBadge();
	// Either may be rejected; the title still shows the badge.
	showing.catch(() => {});
}

/** Running as an installed app, in a window of its own. */
const INSTALLED_APP = "(display-mode: standalone)";

/**
 * Puts `marker` at the start of a tab's title, where a narrow tab can't cut
 * it off. In an installed window it goes after the app's name instead: Chrome
 * and Edge show a title that starts with the name as it is, and put the name
 * in front of any other, which would repeat it.
 */
function markTitle(marker: string): () => void {
	const title = document.title;
	document.title = matchesMedia(INSTALLED_APP) ? `${title} ${marker}` : `${marker} ${title}`;
	return () => {
		document.title = title;
	};
}
