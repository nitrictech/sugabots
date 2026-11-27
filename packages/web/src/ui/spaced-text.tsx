import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * Short facts on one line, such as who and when, with a wider space between
 * them than between words. Empty parts are left out. The parts stay inline, so
 * a line that truncates still truncates.
 */
export function SpacedText({
	parts,
	className,
}: {
	parts: readonly ReactNode[];
	className?: string;
}) {
	const shown = parts.filter(
		(part) => part !== null && part !== undefined && part !== false && part !== "",
	);
	if (shown.length === 0) return null;
	return (
		<span className={className}>
			{shown.map((part, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the parts are fixed for a render and never reorder.
				<span key={index} className={cn(index > 0 && "ms-3")}>
					{part}
				</span>
			))}
		</span>
	);
}
