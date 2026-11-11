import { cn } from "cn";
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * A line of warning with the warning triangle before it, centred on the
 * words. The text is trimmed to its capitals and baseline, so the row centres
 * the icon on what is written rather than on room for descenders, and the
 * icon is the size whose drawn triangle spans the capitals of `text-xs`.
 */
export function WarningText({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<p className={cn("m-0 flex min-w-0 items-center gap-2", className)}>
			<TriangleAlert aria-hidden size={13} strokeWidth={2} className="shrink-0 text-warning" />
			<span className="min-w-0 text-box-cap">{children}</span>
		</p>
	);
}
