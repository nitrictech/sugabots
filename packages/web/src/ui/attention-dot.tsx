import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { Tooltip } from "@/ui/tooltip.tsx";

/*
 * The marks a row or a rail item carries for what waits in it. Each state has
 * one colour wherever it shows, so a dot means the same thing everywhere.
 */

/** What a dot says: something waits on the viewer's decision or reply, or there is news to read. */
export type Attention = "needsYou" | "unread";

const ATTENTION_COLOURS = {
	needsYou: "bg-warning",
	unread: "bg-foreground",
} as const satisfies Record<Attention, string>;

/**
 * A small dot in `attention`'s colour. With `label` it is named by a tooltip
 * and for a screen reader; without, it is hidden from one, for a row whose
 * own text already says it. `className` places or sizes it.
 */
export function AttentionDot({
	attention,
	label,
	className,
}: {
	attention: Attention;
	label?: string;
	className?: string;
}) {
	const dotClassName = cn(
		"size-1.5 shrink-0 rounded-full",
		ATTENTION_COLOURS[attention],
		className,
	);
	if (label === undefined) return <span aria-hidden className={dotClassName} />;
	return (
		<Tooltip label={label} side="right">
			<span className={dotClassName}>
				<span className="sr-only">{label}</span>
			</span>
		</Tooltip>
	);
}

/** A warning mark at a row's end for what is wrong there, named by `label` in a tooltip and for a screen reader. */
export function ProblemMark({ label }: { label: string }) {
	return (
		<Tooltip label={label} side="right">
			<CircleAlert
				role="img"
				aria-label={label}
				size={14}
				strokeWidth={2}
				className="shrink-0 text-destructive-text"
			/>
		</Tooltip>
	);
}
