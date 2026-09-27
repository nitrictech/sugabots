import { and, eq, ne, sql } from "drizzle-orm";
import { Effect, Ref } from "effect";
import type { Database } from "../../database/database.ts";
import { query } from "../../database/database.ts";
import { job } from "../../database/schema.ts";
import {
	cancelJob,
	completeJob,
	failJob,
	queueDeferredJob,
	retryOrFailJob,
} from "../jobs/queue.ts";
import { type ClaimedTurn, MAX_TURN_RUNS, type TurnCheckpoint } from "./store.ts";
import type { SegmentOutcome } from "./turn.workflow.ts";

/**
 * Whatever runs a turn: the job queue, or the turn workflow. The turn worker
 * writes each outcome to the turn's rows and tells the owner in the same
 * transaction, so the owner's bookkeeping never disagrees with the turn.
 */
export interface TurnOwner {
	readonly completed: (claim: ClaimedTurn) => Effect.Effect<void, never, Database>;
	/** The turn is waiting for tool approvals and holds nothing until they are decided. */
	readonly suspended: (
		claim: ClaimedTurn,
		checkpoint: TurnCheckpoint,
	) => Effect.Effect<void, never, Database>;
	/**
	 * Returns whether the turn will be tried again. `retryable` is false once
	 * the turn has a checkpoint or a tool that changes things has run, since a
	 * retry could do it again (ADR 002).
	 */
	readonly failed: (
		claim: ClaimedTurn,
		error: string,
		retryable: boolean,
	) => Effect.Effect<boolean, never, Database>;
	readonly cancelled: (claim: ClaimedTurn, reason: string) => Effect.Effect<void, never, Database>;
	/** The turn could not start at all. */
	readonly discarded: (claim: ClaimedTurn, reason: string) => Effect.Effect<void, never, Database>;
}

const dedupeKeyOf = (claim: ClaimedTurn) => `turn:${claim.threadId}:${claim.payload.agentId}`;

/**
 * Turns as jobs. A job that ends queues any turn asked for while it was
 * waiting for approvals, which it held back.
 */
export const jobTurnOwner: TurnOwner = {
	completed: (claim) =>
		Effect.andThen(
			completeJob(claim.owner),
			query((db) => queueDeferredJob(db, claim.owner)),
		),

	suspended: (claim) =>
		Effect.gen(function* () {
			const dedupeKey = dedupeKeyOf(claim);
			yield* query((db) =>
				db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`),
			);
			// A turn already queued behind this one is held back until it finishes.
			const [deferred] = yield* query((db) =>
				db
					.update(job)
					.set({ status: "cancelled", lastError: "Deferred until approval completes" })
					.where(
						and(eq(job.dedupeKey, dedupeKey), eq(job.status, "queued"), ne(job.id, claim.owner)),
					)
					.returning({ payload: job.payload }),
			);
			const parked = yield* query((db) =>
				db
					.update(job)
					.set({
						status: "waiting",
						lockedAt: null,
						attempts: sql`greatest(${job.attempts} - 1, 0)`,
						...(deferred ? { deferredPayload: deferred.payload } : {}),
					})
					.where(and(eq(job.id, claim.owner), eq(job.status, "running")))
					.returning({ id: job.id }),
			);
			if (parked.length !== 1) {
				return yield* Effect.die(new Error("Suspended turn's job is not running"));
			}
		}),

	failed: (claim, error, retryable) =>
		Effect.gen(function* () {
			const willRetry = retryable
				? yield* retryOrFailJob(
						{ id: claim.owner, attempts: claim.attempts, dedupeKey: dedupeKeyOf(claim) },
						error,
					)
				: yield* Effect.as(failJob(claim.owner, error), false);
			if (!willRetry) yield* query((db) => queueDeferredJob(db, claim.owner));
			return willRetry;
		}),

	cancelled: (claim, reason) =>
		Effect.andThen(
			cancelJob(claim.owner, reason),
			query((db) => queueDeferredJob(db, claim.owner)),
		),

	discarded: (claim, reason) => cancelJob(claim.owner, reason),
};

/** The batch of approvals a checkpoint waits for, named by its first approval. */
export const approvalBatchOf = (checkpoint: TurnCheckpoint) =>
	checkpoint.approvals[0]?.approvalId ?? "none";

/**
 * A segment of the turn workflow. The workflow does the bookkeeping itself,
 * so this only records how the segment ended, for the segment to return.
 */
export const segmentTurnOwner = (outcome: Ref.Ref<SegmentOutcome>): TurnOwner => ({
	completed: () => Effect.void,
	suspended: (_claim, checkpoint) =>
		Ref.set(outcome, { _tag: "Suspended", approvals: approvalBatchOf(checkpoint) }),
	failed: (claim, _error, retryable) => {
		const willRetry = retryable && claim.attempts < MAX_TURN_RUNS;
		return Ref.set(outcome, willRetry ? { _tag: "Retry" } : { _tag: "Finished" }).pipe(
			Effect.as(willRetry),
		);
	},
	cancelled: () => Effect.void,
	discarded: () => Effect.void,
});
