import { Data, Effect } from "effect";
import type { CostEstimate, CostEstimateRevision } from "./types.ts";

export class InvalidEstimateRevisionError extends Data.TaggedError("InvalidEstimateRevisionError")<{
	readonly message: string;
}> {}

export interface CostEstimateRevisionMetadata {
	readonly estimateId: string;
	readonly provenance: string;
	readonly supersedesEstimateId?: string;
	readonly revisionReason?: string;
}

export const costEstimateRevision = Effect.fn("accounting.costEstimateRevision")(function* (
	estimate: CostEstimate,
	metadata: CostEstimateRevisionMetadata,
) {
	return yield* Effect.try({
		try: () => costEstimateRevisionSync(estimate, metadata),
		catch: (cause) =>
			new InvalidEstimateRevisionError({
				message: cause instanceof Error ? cause.message : String(cause),
			}),
	});
});

export function costEstimateRevisionSync(
	estimate: CostEstimate,
	metadata: CostEstimateRevisionMetadata,
): CostEstimateRevision {
	if (!metadata.estimateId || !metadata.provenance) {
		throw new Error("Estimate revision identity and provenance are required");
	}
	if (metadata.supersedesEstimateId && !metadata.revisionReason) {
		throw new Error("A corrected estimate requires a revision reason");
	}
	return Object.freeze({
		...estimate,
		...metadata,
		lines: Object.freeze(estimate.lines.map((line) => Object.freeze({ ...line }))),
		issues: Object.freeze(estimate.issues.map((issue) => Object.freeze({ ...issue }))),
		total: estimate.total ? Object.freeze({ ...estimate.total }) : undefined,
	});
}
