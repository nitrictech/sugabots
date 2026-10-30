import type { AnyRouter, ParsedLocation, RouterHistory } from "@tanstack/react-router";

/*
 * The pages behind this one in the browser's history, as far as this app has
 * been to them. The browser does not say what is behind the current page, so
 * Back cannot otherwise tell whether going back would land where it means to:
 * the list a deleted thing was opened from, or the chat a thread covers.
 */

/** A page in the trail: where it is, and what its address names. */
export interface TrailPage {
	pathname: string;
	search: Record<string, unknown>;
}

/** Each router's pages, by where they are in its history. */
const trails = new WeakMap<RouterHistory, Map<number, TrailPage>>();

/** Records each page `router` comes to, so `pageBehind` can name it later. */
export function followTrail(router: AnyRouter): void {
	const trail = new Map<number, TrailPage>();
	trails.set(router.history, trail);
	router.subscribe("onResolved", ({ toLocation }) => {
		trail.set(historyIndex(toLocation), {
			pathname: toLocation.pathname,
			search: toLocation.search as Record<string, unknown>,
		});
	});
}

/** The page going back from `location` would land on, if this app has been there. */
export function pageBehind(
	history: RouterHistory,
	location: ParsedLocation,
): TrailPage | undefined {
	return trails.get(history)?.get(historyIndex(location) - 1);
}

/** Where `location` is in the browser's history, counted from the app's first page. */
export function historyIndex(location: ParsedLocation): number {
	return (location.state as { __TSR_index?: number }).__TSR_index ?? 0;
}
