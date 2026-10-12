import { useEffect, useEffectEvent } from "react";
import type { AttentionCounts } from "./chats.ts";
import { matchesMedia } from "./media.ts";

/**
 * What the app shows outside the page: how many things are for the person, a
 * dot when only other messages are unread, or nothing.
 */
export type AppBadge = { kind: "count"; count: number } | { kind: "dot" } | { kind: "none" };

/** Mentions and approvals are for the person, so they are counted; other unread messages are a dot. */
export function appBadgeOf({
	unreadMentions,
	waitingApprovals,
	unreadMessages,
}: AttentionCounts): AppBadge {
	const count = unreadMentions + waitingApprovals;
	if (count > 0) return { kind: "count", count };
	if (unreadMessages > 0) return { kind: "dot" };
	return { kind: "none" };
}

/**
 * Shows `badge` outside the page: on the icon of Sugabots installed as an
 * app, and in the title. The title goes back as it was when the badge goes,
 * and the icon is cleared when the caller unmounts.
 */
export function useAppBadge(badge: AppBadge) {
	const marker = titleMarkerOf(badge);
	// Sets the icon straight to the new badge: clearing it first, between two counts, would flicker.
	const showBadgeOnIcon = useEffectEvent(() => showOnIcon(badge));
	useEffect(() => {
		showBadgeOnIcon();
		if (marker === undefined) return;
		return markTitle(marker);
	}, [marker]);
	useEffect(() => () => showOnIcon({ kind: "none" }), []);
}

function titleMarkerOf(badge: AppBadge): string | undefined {
	switch (badge.kind) {
		case "count":
			return `(${badge.count})`;
		case "dot":
			return "•";
		case "none":
			return undefined;
	}
}

/**
 * Shows `badge` on the installed app's icon. `none` clears it, including a
 * badge from before a reload, which the icon keeps.
 */
function showOnIcon(badge: AppBadge) {
	if (!("setAppBadge" in navigator)) return;
	const showing =
		badge.kind === "count"
			? navigator.setAppBadge(badge.count)
			: badge.kind === "dot"
				? navigator.setAppBadge()
				: navigator.clearAppBadge();
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
