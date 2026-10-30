import { useState } from "react";

const STORAGE_KEY_PREFIX = "sugabots-pane-width:";

/**
 * How narrow a list beside the open page may be, in pixels: Inbox's at its
 * narrowest, and the settings navigation, which matches it.
 */
export const LIST_MIN_WIDTH_PX = 280;

/**
 * How wide the viewer last dragged a pane, in pixels, remembered by `name` on
 * this device, and the way to change it; undefined until they first do.
 */
export function usePaneWidth(name: string): [number | undefined, (width: number) => void] {
	const key = STORAGE_KEY_PREFIX + name;
	const [width, setWidth] = useState(() => storedWidth(key));
	const change = (next: number) => {
		const rounded = Math.round(next);
		setWidth(rounded);
		try {
			localStorage.setItem(key, String(rounded));
		} catch {
			// Storage can be off. The pane still keeps its width until the page is left.
		}
	};
	return [width, change];
}

function storedWidth(key: string): number | undefined {
	try {
		const stored = Number(localStorage.getItem(key));
		return Number.isFinite(stored) && stored > 0 ? stored : undefined;
	} catch {
		return undefined;
	}
}
