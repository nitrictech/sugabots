import { cn } from "cn";
import { Tooltip } from "@/ui/tooltip.tsx";

/** What the red dot says, on hover and to a screen reader. */
export const FAILED_DOT_LABEL = "A routine's latest run failed";

/**
 * A red dot while one of a bot's routines' latest run failed, named on hover:
 * at its row's end in the sidebar, and on its Routines button. Inside a
 * control that names it already, `labelled` is false and the dot only shows.
 */
export function FailedDot({
	side = "right",
	labelled = true,
	className,
}: {
	side?: "top" | "bottom" | "right";
	labelled?: boolean;
	className?: string;
}) {
	const dot = cn("size-1.5 shrink-0 rounded-full bg-destructive-text", className);
	if (!labelled) return <span aria-hidden className={dot} />;
	return (
		<Tooltip label={FAILED_DOT_LABEL} side={side}>
			<span className={dot}>
				<span className="sr-only">Latest run failed</span>
			</span>
		</Tooltip>
	);
}
