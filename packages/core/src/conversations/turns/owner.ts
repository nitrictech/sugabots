import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";
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
import type { ClaimedTurn } from "./store.ts";

/**
 * Whatever runs a turn: the job queue now, a workflow later. The turn worker
 * writes each outcome to the turn's rows and tells the owner in the same
 * transaction, so the owner's bookkeeping never disagrees with the turn.
 */
export interface TurnOwner {
	readonly completed: (claim: ClaimedTurn) => Effect.Effect<void, never, Database>;
	/** The turn is waiting for tool approvals and holds nothing until they are decided. */
	readonly suspended: (claim: ClaimedTurn) => Effect.Effect<void, never, Database>;
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
