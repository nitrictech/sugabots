import { useSyncExternalStore } from "react";

/** Whether the member asks for less motion: no slides, glides or other movement that can be left out. */
export const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

/** Tailwind's `md`, from which the list and the chat sit side by side. */
export const SIDE_BY_SIDE = "(min-width: 48rem)";

/** Tailwind's `lg`, from which settings list their sections beside the page rather than as a page of their own. */
export const SETTINGS_BESIDE = "(min-width: 64rem)";

/** Tailwind's `xl`, from which a chat's side panel fits beside it rather than over it. */
export const PANEL_BESIDE = "(min-width: 80rem)";

/** Whether the viewport matches `query` at this moment, for a starting value. */
export function matchesMedia(query: string): boolean {
	return window.matchMedia(query).matches;
}

/** Whether the viewport matches `query` now, following it as the window changes. */
export function useMediaQuery(query: string): boolean {
	return useSyncExternalStore(
		(onChange) => {
			const list = window.matchMedia(query);
			list.addEventListener("change", onChange);
			return () => list.removeEventListener("change", onChange);
		},
		() => window.matchMedia(query).matches,
		() => false,
	);
}
