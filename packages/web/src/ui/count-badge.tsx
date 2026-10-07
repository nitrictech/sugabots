import { cn } from "cn";

/** The most a badge counts; more shows as this with a plus. */
const MAX_COUNTED = 99;

const sizes = {
	/** In a tab, beside its name. */
	sm: "h-4 min-w-[18px] px-[5px] text-[10.5px]",
	/** At the end of a list row. */
	md: "h-[18px] min-w-5 px-1.5 text-[11px]",
	/** On the corner of a rail tile. */
	lg: "h-[22px] min-w-[22px] px-[5px] text-[11px] leading-none",
} as const;

/**
 * How many of something there are, as a filled pill: up to 99, then "99+".
 * `label` says what is counted to assistive technology, such as "3 unread
 * messages"; without it the badge is hidden from it, for a control whose own
 * name already says the count.
 */
export function CountBadge({
	count,
	label,
	size,
	className,
}: {
	count: number;
	label?: string;
	size: keyof typeof sizes;
	/** Merged over its own, for its place and ring, or another fill. */
	className?: string;
}) {
	return (
		<span
			aria-hidden={label === undefined ? true : undefined}
			className={cn(
				"grid shrink-0 place-items-center rounded-full bg-rail-count font-semibold text-primary-foreground",
				sizes[size],
				className,
			)}
		>
			<span aria-hidden>{count > MAX_COUNTED ? `${MAX_COUNTED}+` : count}</span>
			{label !== undefined && <span className="sr-only">{label}</span>}
		</span>
	);
}
