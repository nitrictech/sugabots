/** The sentence an outcome records for a cause it did not expect. */
export function describeFailure(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
