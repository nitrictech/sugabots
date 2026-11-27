/** The most a badge counts; more shows as this with a plus. */
const MAX_COUNTED = 99;

/**
 * How many of something there are, as a filled pill: up to 99, then "99+".
 * `label` says what is counted to assistive technology, such as "3 waiting on
 * you".
 */
export function CountBadge({ count, label }: { count: number; label: string }) {
	return (
		<span className="grid h-4 min-w-5 shrink-0 place-items-center rounded-full bg-rail-count px-1 font-semibold text-2xs text-primary-foreground">
			<span aria-hidden>{count > MAX_COUNTED ? `${MAX_COUNTED}+` : count}</span>
			<span className="sr-only">{label}</span>
		</span>
	);
}
