export * as BlobDeletions from "./deletions.ts";

import { and, eq, inArray, lte } from "drizzle-orm";
import { DateTime, Duration, Effect, Layer, Schedule } from "effect";
import { type Database, query } from "../database/database.ts";
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
