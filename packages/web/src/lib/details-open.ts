import { useCallback, useState } from "react";
import { matchesMedia, SIDEBAR_BESIDE } from "@/lib/media.ts";

const STORAGE_KEY = "sugabots-details-open";

/**
 * Whether a chat's Details sidebar is open, remembered on this device: closing
 * it keeps it closed for every chat opened after, until it is opened again.
 * It starts open only where it sits beside the chat; on a smaller screen it
 * would cover it, so there it starts closed whatever was remembered.
 */
export function useDetailsOpen(): [boolean, (open: boolean) => void] {
	const [open, setOpen] = useState(() => matchesMedia(SIDEBAR_BESIDE) && wasLeftOpen());
	const change = useCallback((next: boolean) => {
		setOpen(next);
		// Only where it sits beside the chat: closing it over the chat on a phone is not a preference.
		if (!matchesMedia(SIDEBAR_BESIDE)) return;
		try {
			if (next) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, "closed");
		} catch {
			// Storage can be off. It still opens and closes for this chat.
		}
	}, []);
	return [open, change];
}

/** Open unless it was last closed; open is the default, so only closed is stored. */
function wasLeftOpen(): boolean {
	try {
		return localStorage.getItem(STORAGE_KEY) !== "closed";
	} catch {
		return true;
	}
}
