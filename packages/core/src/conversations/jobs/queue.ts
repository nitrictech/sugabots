import { and, eq, ne, type SQL, sql } from "drizzle-orm";
import { Data, Effect } from "effect";
import { type Database, query, transaction } from "../../database/database.ts";
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
	query(async (db) => {
		const result = await db.execute(sql`
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
		`);
		const [claimed] = result.rows as Array<{
			id: string;
			thread_id: string;
			payload: JobPayloadOf<Kind>;
			dedupe_key: string;
			attempts: number;
		}>;
		return claimed
			? {
					id: claimed.id,
					threadId: claimed.thread_id,
					payload: claimed.payload,
					dedupeKey: claimed.dedupe_key,
					attempts: claimed.attempts,
				}
			: undefined;
	});

/**
 * Puts back jobs left `running` by a process that stopped mid-way, so they are
 * claimed again. A job queued behind an interrupted one for the same work is
 * cancelled first, because two queued jobs may not share a key and the retry
 * covers whatever the later one was for.
 */
export const requeueInterruptedJobs = (kind: JobKind): Effect.Effect<void, never, Database> =>
	transaction(
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
								and active.status = 'running'
								and active.dedupe_key = queued.dedupe_key
						)
				`),
			);
			yield* query((db) =>
				db
					.update(job)
					.set({ status: "queued", lockedAt: null, availableAt: new Date() })
					.where(and(eq(job.kind, kind), eq(job.status, "running"))),
			);
		}),
	);

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
export async function queueDeferredJob(
	db: import("../../database/database.ts").Executor,
	jobId: string,
): Promise<void> {
	const [ended] = await db
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
	await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${ended.dedupeKey}, 0))`);
	await db.update(job).set({ deferredPayload: null }).where(eq(job.id, jobId));
	await db
		.insert(job)
		.values({
			kind: ended.kind,
			threadId: ended.threadId,
			dedupeKey: ended.dedupeKey,
			payload: ended.payload,
		})
		.onConflictDoNothing();
}

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
	query(async (db) => {
		const [newer] = await db
			.select({ id: job.id })
			.from(job)
			.where(
				and(eq(job.dedupeKey, claimed.dedupeKey), eq(job.status, "queued"), ne(job.id, claimed.id)),
			)
			.limit(1);
		return newer !== undefined;
	});

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
