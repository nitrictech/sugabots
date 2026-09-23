import { useCallback, useEffect, useState } from "react";

/**
 * Which pods are folded shut in the rail, remembered per workspace.
 *
 * This is a view preference rather than anything about the pod — two people in
 * the same pod fold different ones — so it lives in this browser and never
 * reaches the API. A pod is open unless it is listed as folded, which is why a
 * workspace nobody has touched yet opens with everything showing.
 *
 * Storage can be off or full. Every path here survives that: the fold still
 * works for the session, it is only forgotten on the next load.
 */

const KEY = "sugabots-folded-pods";

type FoldedByWorkspace = Record<string, string[]>;

export interface PodFolding {
	isFolded: (podId: string) => boolean;
	toggle: (podId: string) => void;
	/** Opens a pod that is folded, and does nothing to one already open. */
	unfold: (podId: string) => void;
}

export function useFoldedPods(workspaceId: string | undefined): PodFolding {
	const [folded, setFolded] = useState<ReadonlySet<string>>(() => read(workspaceId));

	// Switching workspaces switches the set: the pods in the address bar are
	// gone, and the ones arriving have their own remembered state.
	useEffect(() => {
		setFolded(read(workspaceId));
	}, [workspaceId]);

	const store = useCallback(
		(next: ReadonlySet<string>) => {
			setFolded(next);
			write(workspaceId, next);
		},
		[workspaceId],
	);

	const toggle = useCallback(
		(podId: string) => {
			const next = new Set(folded);
			if (!next.delete(podId)) {
				next.add(podId);
			}
			store(next);
		},
		[folded, store],
	);

	const unfold = useCallback(
		(podId: string) => {
			if (!folded.has(podId)) return;
			const next = new Set(folded);
			next.delete(podId);
			store(next);
		},
		[folded, store],
	);

	const isFolded = useCallback((podId: string) => folded.has(podId), [folded]);

	return { isFolded, toggle, unfold };
}

function read(workspaceId: string | undefined): ReadonlySet<string> {
	if (workspaceId === undefined) return new Set();
	try {
		const stored = localStorage.getItem(KEY);
		if (stored === null) return new Set();
		const parsed: unknown = JSON.parse(stored);
		const forWorkspace = (parsed as FoldedByWorkspace | null)?.[workspaceId];
		return new Set(Array.isArray(forWorkspace) ? forWorkspace.filter(isString) : []);
	} catch {
		return new Set();
	}
}

function write(workspaceId: string | undefined, folded: ReadonlySet<string>): void {
	if (workspaceId === undefined) return;
	try {
		const stored = localStorage.getItem(KEY);
		const parsed: unknown = stored === null ? {} : JSON.parse(stored);
		const all: FoldedByWorkspace = isRecord(parsed) ? (parsed as FoldedByWorkspace) : {};
		if (folded.size === 0) {
			delete all[workspaceId];
		} else {
			all[workspaceId] = [...folded];
		}
		localStorage.setItem(KEY, JSON.stringify(all));
	} catch {
		// Storage can be off or full. The fold holds for this session either way.
	}
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
