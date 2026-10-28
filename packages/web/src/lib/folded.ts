import { useState } from "react";

const STORAGE_KEY = "sugabots-folded";

/**
 * Which parts of the sidebar the viewer folded away, by key, remembered on
 * this device, and the way to fold or unfold one. Everything starts unfolded.
 */
export function useFolded(): [ReadonlySet<string>, (key: string) => void] {
	const [folded, setFolded] = useState(storedFolded);
	const toggle = (key: string) => {
		// From storage, not this copy, so folds made through another copy are kept.
		const next = new Set(storedFolded());
		if (!next.delete(key)) next.add(key);
		setFolded(next);
		try {
			if (next.size === 0) localStorage.removeItem(STORAGE_KEY);
			else localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
		} catch {
			// Storage can be off. It still folds until the page is left.
		}
	};
	return [folded, toggle];
}

function storedFolded(): ReadonlySet<string> {
	try {
		const stored: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
		return new Set(Array.isArray(stored) ? stored.filter((key) => typeof key === "string") : []);
	} catch {
		return new Set();
	}
}
