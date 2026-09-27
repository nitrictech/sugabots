import type { ReactNode } from "react";

/**
 * A numbered walkthrough. Wrap a Markdown numbered list, one step per item;
 * each item's first line is its title.
 */
export function Steps({ children }: { children: ReactNode }) {
	return <div className="docs-steps">{children}</div>;
}
