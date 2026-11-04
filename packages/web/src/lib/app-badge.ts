import { useEffect } from "react";

/**
 * Shows `count` on the icon of Sugabots installed as an app. Nothing shows
 * while it is zero, and the icon is cleared when the caller unmounts.
 */
export function useAppBadge(count: number) {
	useEffect(() => {
		// Sets the icon straight to the new count: clearing it first, between two counts, would flicker.
		showOnIcon(count);
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
	// Either may be rejected; the page's title shows the count too.
	showing.catch(() => {});
}
