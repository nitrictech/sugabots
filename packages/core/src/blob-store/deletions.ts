export * as BlobDeletions from "./deletions.ts";

import { and, eq, inArray, lte } from "drizzle-orm";
import { DateTime, Duration, Effect, Layer, Schedule } from "effect";
import { type Database, query, Transaction, writtenRow } from "../database/database.ts";
import { blobDeletion } from "../database/schema.ts";
import { processLayer } from "../tiers.ts";
import { BlobStore } from "./blob-store.ts";

/** How long a queued deletion waits at most, which is how long an unreachable blob lingers. */
const INTERVAL = Duration.minutes(1);

/** How many queued prefixes one claim takes. */
const BATCH_SIZE = 100;

/**
 * How long a worker has the prefixes it claimed to itself, after which another
 * takes them up: one that stopped part-way leaves them to come due again.
 */
const CLAIM_LEASE = Duration.minutes(5);

/**
 * Works through `blob_deletion` every `INTERVAL` for as long as the layer's
 * scope is open, starting at once, so blobs queued before a restart go too.
 */
export const layer = Layer.effectDiscard(
	Effect.gen(function* () {
		const context = yield* Effect.context<Database | BlobStore.Service>();
		yield* Effect.forkScoped(
			deleteQueued.pipe(
				Effect.catchCause((cause) => Effect.logError("Deleting queued blobs failed", cause)),
				Effect.repeat(Schedule.spaced(INTERVAL)),
				Effect.provideContext(context),
			),
		);
	}),
).pipe(processLayer);

/**
 * Deletes the blob stored under every queued prefix that is due, and every
 * blob under it, then its queue row, a batch at a time until none are due.
 *
 * A batch is claimed in one statement that moves each row's `due_at` past
 * {@link CLAIM_LEASE}, skipping rows another worker is claiming, so no row is
 * locked while the store deletes. Each prefix's row goes once its blobs have,
 * unless it was claimed again meanwhile. A failure stops the batch; what it
 * left is taken up again once its lease has passed, and deleting a prefix
 * whose blobs are already gone does nothing, so a retry is harmless.
 */
export const deleteQueued: Effect.Effect<void, BlobStore.Failure, Database | BlobStore.Service> =
	Effect.gen(function* () {
		const blobs = yield* BlobStore.Service;
		const deleteBatch = Effect.gen(function* () {
			const now = yield* DateTime.now;
			const claimed = yield* query((db) =>
				db
					.update(blobDeletion)
					.set({ dueAt: DateTime.toDateUtc(DateTime.addDuration(now, CLAIM_LEASE)) })
					.where(
						inArray(
							blobDeletion.id,
							db
								.select({ id: blobDeletion.id })
								.from(blobDeletion)
								.where(lte(blobDeletion.dueAt, DateTime.toDateUtc(now)))
								.orderBy(blobDeletion.dueAt, blobDeletion.id)
								.limit(BATCH_SIZE)
								.for("update", { skipLocked: true }),
						),
					)
					.returning(),
			);
			yield* Effect.forEach(
				claimed,
				({ id, prefix, dueAt }) =>
					Effect.andThen(
						Effect.andThen(blobs.delete(prefix), blobs.deletePrefix(prefix)),
						query((db) =>
							db
								.delete(blobDeletion)
								.where(and(eq(blobDeletion.id, id), eq(blobDeletion.dueAt, dueAt))),
						),
					),
				{ discard: true },
			);
			return claimed.length;
		});
		// A short batch means nothing more was due.
		yield* Effect.repeat(deleteBatch, { while: (claimed) => claimed === BATCH_SIZE });
	}).pipe(Effect.withSpan("BlobDeletions.deleteQueued"));

/** How long a writer has to record a blob it staged before the queue deletes it. */
const STAGING_GRACE = Duration.hours(1);

/**
 * A blob a writer is storing, whose deletion was queued before any of its
 * bytes were, due once {@link STAGING_GRACE} has passed: bytes stored and
 * never recorded, by a writer that failed or a process that stopped, are
 * deleted all the same. The writer keeps it with {@link keepStaged}.
 */
export interface Staged {
	readonly deletionId: string;
	/** When the deletion is due, until a worker claims it by moving this on. */
	readonly dueAt: Date;
}

/** Queues the blob about to be stored under `key` for deletion, as {@link Staged} says. */
export const stage = (key: BlobStore.Key): Effect.Effect<Staged, never, Database> =>
	Effect.gen(function* () {
		const now = yield* DateTime.now;
		return yield* query((db) =>
			db
				.insert(blobDeletion)
				.values({
					prefix: key,
					dueAt: DateTime.toDateUtc(DateTime.addDuration(now, STAGING_GRACE)),
				})
				.returning({ deletionId: blobDeletion.id, dueAt: blobDeletion.dueAt }),
		).pipe(Effect.flatMap(writtenRow("blob_deletion")));
	});

/**
 * Keeps `staged`'s blob, in the transaction that records it, by forgetting
 * its queued deletion while no worker has claimed it. One claimed is a
 * defect: its writer was held up past its grace, and its bytes are, or soon
 * will be, gone, so recording them would leave a row without its blob.
 */
export const keepStaged = (staged: Staged): Effect.Effect<void, never, Database | Transaction> =>
	Effect.gen(function* () {
		yield* Transaction;
		const [kept] = yield* query((db) =>
			db
				.delete(blobDeletion)
				.where(and(eq(blobDeletion.id, staged.deletionId), eq(blobDeletion.dueAt, staged.dueAt)))
				.returning({ id: blobDeletion.id }),
		);
		if (!kept) {
			return yield* Effect.die(
				new Error("A staged blob's deletion was claimed before its writer recorded it"),
			);
		}
	});
