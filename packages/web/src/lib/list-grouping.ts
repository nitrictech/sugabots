import { useCallback, useState } from "react";

/** How a pod's conversation list orders its threads and routines. */
export type ListGrouping = "recent" | "bot";

const STORAGE_KEY_PREFIX = "sugabots-list-grouping:";

/**
 * How the viewer last chose to see a pod's list, remembered for that pod on
 * this device. By bot is the default, so only newest first is stored.
 */
export function useListGrouping(podId: string): [ListGrouping, (grouping: ListGrouping) => void] {
	const key = STORAGE_KEY_PREFIX + podId;
	const [chosen, setChosen] = useState<{ podId: string; grouping: ListGrouping }>();
	const grouping = chosen?.podId === podId ? chosen.grouping : storedGrouping(key);
	const change = useCallback(
		(next: ListGrouping) => {
			setChosen({ podId, grouping: next });
			try {
				if (next === "recent") localStorage.setItem(key, next);
				else localStorage.removeItem(key);
			} catch {
				// Storage can be off. The list still changes until the page is left.
			}
		},
		[podId, key],
	);
	return [grouping, change];
}

function storedGrouping(key: string): ListGrouping {
	try {
		return localStorage.getItem(key) === "recent" ? "recent" : "bot";
	} catch {
		return "bot";
	}
}

const FOLDED_KEY_PREFIX = "sugabots-folded-bots:";

/**
 * Which of a pod's bot sections the viewer folded, by the section's key,
 * remembered for that pod on this device, and the way to fold or unfold one.
 */
export function useFoldedBots(podId: string): [ReadonlySet<string>, (key: string) => void] {
	const storageKey = FOLDED_KEY_PREFIX + podId;
	const [chosen, setChosen] = useState<{ podId: string; folded: ReadonlySet<string> }>();
	const folded = chosen?.podId === podId ? chosen.folded : storedFolded(storageKey);
	const toggle = (key: string) => {
		const next = new Set(folded);
		if (!next.delete(key)) next.add(key);
		setChosen({ podId, folded: next });
		try {
			if (next.size === 0) localStorage.removeItem(storageKey);
			else localStorage.setItem(storageKey, JSON.stringify([...next]));
		} catch {
			// Storage can be off. The section still folds until the page is left.
		}
	};
	return [folded, toggle];
}

function storedFolded(storageKey: string): ReadonlySet<string> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "[]");
		return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
	} catch {
		return new Set();
	}
}
