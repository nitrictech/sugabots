import { and, eq, inArray, ne, type SQL, sql } from "drizzle-orm";
import { Data, Duration, Effect } from "effect";
import { type Database, type Executor, query, transaction } from "../../database/database.ts";
import { type JobKind, type JobPayloadOf, job } from "../../database/schema.ts";

/**
 * The job queue: a Postgres table that background workers claim work from.
 *
 * One row is one piece of work about one thread. A `dedupeKey` names the work
 * so that asking for it twice while it is queued or waiting does not queue it twice.
 * A job may be `queued`, `running`, or finished as
 * `done`, `failed` or `cancelled`.
 *
 * Two workers use this, for turns and for thread summaries. Each decides what
 * a job means; this file only knows how to hand one out and record how it
 * ended.
 */

/** Give up on a job after this many attempts. */
const MAX_ATTEMPTS = 3;

export const hasPendingResponseJob = (threadId: SQL) => sql<boolean>`exists (
	select 1 from ${job}
	where ${job.threadId} = ${threadId}
		and ${job.kind} in ('turn', 'facilitate')
		and ${job.status} in ('queued', 'running', 'waiting')
)`;

/**
 * A claimed job that cannot run and should be discarded: its subject is gone,
 * or newer work has made it pointless. `reason` is recorded on the job.
 */
export class JobNotRunnable extends Data.TaggedError("JobNotRunnable")<{
	readonly reason: string;
	readonly terminalOutcome?: { state: "failed" | "cancelled"; error?: string };
}> {
	override get message() {
		return this.reason;
	}
}

export interface ClaimedJob<Kind extends JobKind> {
	id: string;
	threadId: string;
	payload: JobPayloadOf<Kind>;
	dedupeKey: string;
	/** How many times this job has been claimed, counting this one. */
	attempts: number;
}

export interface NewJob<Kind extends JobKind> {
	kind: Kind;
	threadId: string;
	payload: JobPayloadOf<Kind>;
	dedupeKey: string;
	/**
	 * What to do when a job with this key is already queued. `keep` leaves the
	 * queued one as it is; `replacePayload` gives it this payload, for work
	 * where the newest request supersedes the older.
	 */
	ifAlreadyQueued: "keep" | "replacePayload";
}

/** Queues a job, unless the same work is already queued. */
export const enqueueJob = <Kind extends JobKind>(
	input: NewJob<Kind>,
): Effect.Effect<void, never, Database> =>
	transaction(
		Effect.gen(function* () {
			yield* lockDedupeKey(input.dedupeKey);
			const [existing] = yield* query((db) =>
				db
					.select({ id: job.id, status: job.status })
					.from(job)
					.where(
						and(eq(job.dedupeKey, input.dedupeKey), sql`${job.status} in ('queued', 'waiting')`),
					)
					.limit(1),
			);
			if (existing) {
				if (existing.status === "waiting") {
					yield* query((db) =>
						db
							.update(job)
							.set({ deferredPayload: input.payload, updatedAt: new Date() })
							.where(
								and(
									eq(job.id, existing.id),
									eq(job.status, "waiting"),
									sql`${job.deferredPayload} is null`,
								),
							),
					);
				}
				if (existing.status === "queued" && input.ifAlreadyQueued === "replacePayload") {
					yield* query((db) =>
						db
							.update(job)
							.set({ payload: input.payload, updatedAt: new Date() })
							.where(and(eq(job.id, existing.id), eq(job.status, "queued"))),
					);
				}
				return;
			}
			yield* query((db) =>
				db
					.insert(job)
					.values({
						kind: input.kind,
						threadId: input.threadId,
						payload: input.payload,
						dedupeKey: input.dedupeKey,
					})
					.onConflictDoNothing(),
			);
		}),
	).pipe(Effect.asVoid);

/**
 * Holds the key until the transaction ends, so an enqueue and a retry of the
 * same work cannot interleave and both try to be the one queued row.
 */
const lockDedupeKey = (dedupeKey: string) =>
	query((db) => db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${dedupeKey}, 0))`));

/**
 * Claims the oldest job of a kind that is due and whose work is not already
 * running, marking it `running`. `skip locked` lets several workers claim at
 * once without handing the same job to two of them.
 */
export const claimNextJob = <Kind extends JobKind>(
	kind: Kind,
): Effect.Effect<ClaimedJob<Kind> | undefined, never, Database> =>
	query((db) =>
		Effect.gen(function* () {
			const rows = yield* db.execute<{
				id: string;
				thread_id: string;
				payload: JobPayloadOf<Kind>;
				dedupe_key: string;
				attempts: number;
			}>(
				sql`
			with candidate as (
				select queued.id
				from ${job} queued
				where queued.kind = ${kind}
					and queued.status = 'queued'
					and queued.available_at <= now()
					and not exists (
						select 1 from ${job} active
						where active.dedupe_key = queued.dedupe_key
							and active.status in ('running', 'waiting')
					)
				order by queued.available_at, queued.created_at, queued.id
				for update skip locked
				limit 1
			)
			update ${job}
			set status = 'running', attempts = attempts + 1, locked_at = now(), updated_at = now()
			where id = (select id from candidate)
			returning id, thread_id, payload, dedupe_key, attempts
		`,
				"objects",
			);
			const [claimed] = rows;
			return claimed
				? {
						id: claimed.id,
						threadId: claimed.thread_id,
						payload: claimed.payload,
						dedupeKey: claimed.dedupe_key,
						attempts: claimed.attempts,
					}
				: undefined;
		}),
	);

/**
 * How long a running job's lease lasts without renewal. The worker holding it
 * renews it well within this (see `workerLayer`), so a job whose lease has
 * lapsed belongs to a process that stopped, not one that is still running it.
 */
export const JOB_LEASE = Duration.seconds(60);

/** Extends the leases of the running jobs a worker holds. */
export const renewJobLeases = (jobIds: readonly string[]): Effect.Effect<void, never, Database> =>
	query((db) =>
		db
			.update(job)
			.set({ lockedAt: sql`now()` })
			.where(and(inArray(job.id, [...jobIds]), eq(job.status, "running"))),
	).pipe(Effect.asVoid);

/**
 * Puts back jobs whose lease has lapsed, so they are claimed again. A job
 * queued behind one of them for the same work is cancelled first, because two
 * queued jobs may not share a key and the retry covers whatever the later one
 * was for.
 */
export const requeueInterruptedJobs = (kind: JobKind): Effect.Effect<void, never, Database> => {
	const lapsed = (alias: SQL) =>
		sql`${alias}.status = 'running' and ${alias}.locked_at < now() - make_interval(secs => ${Duration.toSeconds(JOB_LEASE)})`;
	return transaction(
		Effect.gen(function* () {
			yield* query((db) =>
				db.execute(sql`
					update ${job} queued
					set status = 'cancelled', updated_at = now()
					where queued.kind = ${kind}
						and queued.status = 'queued'
						and exists (
							select 1 from ${job} active
							where active.kind = ${kind}
								and ${lapsed(sql`active`)}
								and active.dedupe_key = queued.dedupe_key
						)
				`),
			);
			yield* query((db) =>
				db.execute(sql`
					update ${job} expired
					set status = 'queued', locked_at = null, available_at = now(), updated_at = now()
					where expired.kind = ${kind} and ${lapsed(sql`expired`)}
				`),
			);
		}),
	);
};

export const completeJob = (jobId: string): Effect.Effect<void, never, Database> =>
	query((db) =>
		// The error is cleared: a job that failed an attempt and then succeeded
		// was left carrying the error from the attempt that did not count, which
		// reads as a failure to anyone looking at the table afterwards.
		db
			.update(job)
			.set({ status: "done", lockedAt: null, lastError: null })
			.where(eq(job.id, jobId)),
	).pipe(Effect.asVoid);

/** Ends a job that will never run: its subject is gone, or newer work replaces it. */
export const cancelJob = (jobId: string, reason: string): Effect.Effect<void, never, Database> =>
	query((db) =>
		db
			.update(job)
			.set({ status: "cancelled", lastError: reason, lockedAt: null })
			.where(eq(job.id, jobId)),
	).pipe(Effect.asVoid);

export const failJob = (jobId: string, error: string): Effect.Effect<void, never, Database> =>
	query((db) =>
		db
			.update(job)
			.set({ status: "failed", lastError: error, lockedAt: null })
			.where(eq(job.id, jobId)),
	).pipe(Effect.asVoid);

/** Queues work coalesced while an approval was waiting, after its owning job ends. */
export const queueDeferredJob = Effect.fn("JobQueue.queueDeferredJob")(function* (
	db: Executor,
	jobId: string,
) {
	const [ended] = yield* db
		.select({
			kind: job.kind,
			threadId: job.threadId,
			dedupeKey: job.dedupeKey,
			payload: job.deferredPayload,
		})
		.from(job)
		.where(eq(job.id, jobId))
		.limit(1);
	if (!ended?.payload) return;
	yield* db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ended.dedupeKey}, 0))`);
	yield* db.update(job).set({ deferredPayload: null }).where(eq(job.id, jobId));
	yield* db
		.insert(job)
		.values({
			kind: ended.kind,
			threadId: ended.threadId,
			dedupeKey: ended.dedupeKey,
			payload: ended.payload,
		})
		.onConflictDoNothing();
});

/**
 * Records a failed attempt. The job is queued again with a growing delay, or
 * marked `failed` once it has used its attempts. Returns whether it will retry.
 *
 * A job queued behind this one for the same work is cancelled when retrying,
 * since two queued jobs may not share a key and the retry covers it.
 */
export const retryOrFailJob = (
	claimed: Pick<ClaimedJob<JobKind>, "id" | "dedupeKey" | "attempts">,
	error: string,
): Effect.Effect<boolean, never, Database> =>
	transaction(
		Effect.gen(function* () {
			yield* lockDedupeKey(claimed.dedupeKey);
			const willRetry = claimed.attempts < MAX_ATTEMPTS;
			if (willRetry) {
				yield* cancelQueuedDuplicates(claimed);
			}
			yield* query((db) =>
				db
					.update(job)
					.set({
						status: willRetry ? "queued" : "failed",
						lastError: error,
						lockedAt: null,
						availableAt: new Date(Date.now() + retryDelayMs(claimed.attempts)),
					})
					.where(eq(job.id, claimed.id)),
			);
			return willRetry;
		}),
	);

/**
 * For work where the newest request supersedes the older: retries the job
 * unless a newer one with the same key is already queued, in which case this
 * one is failed and the newer one runs.
 */
export const retryUnlessSuperseded = (
	claimed: Pick<ClaimedJob<JobKind>, "id" | "dedupeKey" | "attempts">,
	error: string,
): Effect.Effect<void, never, Database> =>
	Effect.flatMap(hasQueuedDuplicate(claimed), (superseded) =>
		superseded ? failJob(claimed.id, error) : Effect.asVoid(retryOrFailJob(claimed, error)),
	);

/** Whether newer work with the same key is waiting behind this job. */
export const hasQueuedDuplicate = (
	claimed: Pick<ClaimedJob<JobKind>, "id" | "dedupeKey">,
): Effect.Effect<boolean, never, Database> =>
	query((db) =>
		db
			.select({ id: job.id })
			.from(job)
			.where(
				and(eq(job.dedupeKey, claimed.dedupeKey), eq(job.status, "queued"), ne(job.id, claimed.id)),
			)
			.limit(1),
	).pipe(Effect.map((newer) => newer.length > 0));

const cancelQueuedDuplicates = (claimed: Pick<ClaimedJob<JobKind>, "id" | "dedupeKey">) =>
	query((db) =>
		db
			.update(job)
			.set({ status: "cancelled", lockedAt: null })
			.where(
				and(eq(job.dedupeKey, claimed.dedupeKey), eq(job.status, "queued"), ne(job.id, claimed.id)),
			),
	);

/** One second, then two, then four: attempt 1 waits 1s before attempt 2. */
function retryDelayMs(attempts: number): number {
	return 1_000 * 2 ** Math.max(0, attempts - 1);
}
