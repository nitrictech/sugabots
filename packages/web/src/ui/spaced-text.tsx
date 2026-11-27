import { cn } from "cn";
import { Fragment, type ReactNode } from "react";

/**
 * Short facts on one line, such as who and when, with a wider space between
 * them than between words. Empty parts are left out. The parts stay inline, so
 * a line that truncates still truncates. A real space separates them, so a
 * screen reader and copied text keep the facts apart too.
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
				<Fragment key={index}>
					{index > 0 && " "}
					<span className={cn(index > 0 && "ms-2")}>{part}</span>
				</Fragment>
			))}
		</span>
	);
}
