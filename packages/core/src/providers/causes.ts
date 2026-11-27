/** How many causes deep {@link causesOf} follows, so a cycle can't go on forever. */
const MAX_CAUSE_DEPTH = 5;

/**
 * `error`, then each error it was caused by, nearest first, at most
 * {@link MAX_CAUSE_DEPTH} in all. A cause that is not an `Error` is the last.
 */
export function causesOf(error: unknown): readonly unknown[] {
	const causes: unknown[] = [];
	for (
		let current = error;
		current !== undefined && causes.length < MAX_CAUSE_DEPTH;
		current = current instanceof Error ? current.cause : undefined
	) {
		causes.push(current);
	}
	return causes;
}
