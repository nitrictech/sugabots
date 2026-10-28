import { useState } from "react";

const STORAGE_KEY_PREFIX = "sugabots-open-bots:";

/**
 * Which of a pod's bots the viewer opened in the sidebar to show their
 * threads, by the bot's key, remembered for that pod on this device, and the
 * way to open or close one. A bot starts closed.
 */
export function useOpenBots(podId: string): [ReadonlySet<string>, (key: string) => void] {
	const storageKey = STORAGE_KEY_PREFIX + podId;
	const [chosen, setChosen] = useState<{ podId: string; open: ReadonlySet<string> }>();
	const open = chosen?.podId === podId ? chosen.open : storedOpen(storageKey);
	const toggle = (key: string) => {
		const next = new Set(open);
		if (!next.delete(key)) next.add(key);
		setChosen({ podId, open: next });
		try {
			if (next.size === 0) localStorage.removeItem(storageKey);
			else localStorage.setItem(storageKey, JSON.stringify([...next]));
		} catch {
			// Storage can be off. The bot still opens until the page is left.
		}
	};
	return [open, toggle];
}

function storedOpen(storageKey: string): ReadonlySet<string> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
		return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
	} catch {
		return new Set();
	}
}
