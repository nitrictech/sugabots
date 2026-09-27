import { type HistoryState, useLocation, useRouter } from "@tanstack/react-router";
import type { MouseEvent } from "react";
import type { BackTarget } from "@/ui/settings-page.tsx";

/*
 * Where Back goes in settings: the page you came from, as a browser's Back
 * does, rather than a fixed parent. A link that goes deeper from where you are
 * (a pod to one of its bots, a chat to its bot's settings) writes the page it
 * leaves into the history entry it opens, and Back is the browser's own Back
 * to that entry. A navigation that writes nothing, such as picking a section,
 * leaves the page its parent's Back, so a link that forgets never offers a way
 * back to somewhere you chose to leave.
 */

const CAME_FROM = "settingsCameFrom";

interface CameFrom {
	href: string;
	label: string;
}

/**
 * History state for a link or `navigate` from this page, whose destination's
 * Back returns here under `label`: `state={useBackToHere("Chat")}`.
 */
export function useBackToHere(label: string): (state: HistoryState) => HistoryState {
	const href = useLocation({ select: (location) => location.href });
	return (state) => {
		// Through a variable: `HistoryState` declares no fields, so a literal
		// returned as one is refused for the field it adds.
		const next = { ...state, [CAME_FROM]: { href, label } satisfies CameFrom };
		return next;
	};
}

/** Back from the current settings page to the one it was opened from, if it says. */
export function useSettingsBack(): BackTarget | undefined {
	const router = useRouter();
	const cameFrom = useLocation({ select: (location) => parseCameFrom(location.state) });
	if (!cameFrom) return undefined;
	return {
		label: cameFrom.label,
		render: (
			// biome-ignore lint/a11y/useAnchorContent: an element to render, which the Back link fills with its label.
			<a
				href={cameFrom.href}
				onClick={(event) => {
					// A click that opens a new tab or window follows the address instead.
					if (isPlainClick(event)) {
						event.preventDefault();
						router.history.back();
					}
				}}
			/>
		),
	};
}

/** Back to the page you came from, or to `parent`, the page this one sits under, when there is none. */
export function useBackTarget(parent: BackTarget): BackTarget {
	return useSettingsBack() ?? parent;
}

/** History state outlives the code that wrote it, so an entry from an older build is checked, not trusted. */
function parseCameFrom(state: HistoryState): CameFrom | undefined {
	const value: unknown = (state as Record<string, unknown>)[CAME_FROM];
	if (typeof value !== "object" || value === null) return undefined;
	const { href, label } = value as Record<string, unknown>;
	return typeof href === "string" && typeof label === "string" ? { href, label } : undefined;
}

function isPlainClick(event: MouseEvent): boolean {
	return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}
