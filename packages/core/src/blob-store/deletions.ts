export * as BlobDeletions from "./deletions.ts";

import { inArray } from "drizzle-orm";
import { Duration, Effect, Layer, Schedule } from "effect";
import { type Database, query, transaction } from "../database/database.ts";
import { blobDeletion } from "../database/schema.ts";
import { BlobStore } from "./blob-store.ts";

/** How long a queued deletion waits at most, which is how long an unreachable blob lingers. */
const INTERVAL = Duration.minutes(1);

/** Prefixes deleted per transaction, which holds their queue rows locked meanwhile. */
const BATCH_SIZE = 100;

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
);

/**
 * Deletes the blobs under every queued prefix, then their queue rows, a batch
 * per transaction until the queue is empty.
 *
 * A batch's rows are claimed with `SKIP LOCKED`, so several processes share
 * the queue without deleting the same prefix twice. A failure rolls its batch
 * back to be tried again on the next run: deleting a prefix whose blobs are
 * already gone does nothing, so a retry is harmless.
 */
export const deleteQueued: Effect.Effect<void, BlobStore.Failure, Database | BlobStore.Service> =
	Effect.gen(function* () {
		const blobs = yield* BlobStore.Service;
		const deleteBatch = transaction(
			Effect.gen(function* () {
				const claimed = yield* query((db) =>
					db.select().from(blobDeletion).limit(BATCH_SIZE).for("update", { skipLocked: true }),
				);
				yield* Effect.forEach(claimed, ({ prefix }) => blobs.deletePrefix(prefix), {
					discard: true,
				});
				const ids = claimed.map(({ id }) => id);
				if (ids.length > 0) {
					yield* query((db) => db.delete(blobDeletion).where(inArray(blobDeletion.id, ids)));
				}
				return claimed.length;
			}),
		);
		// A short batch means the queue was emptied.
		yield* Effect.repeat(deleteBatch, { while: (claimed) => claimed === BATCH_SIZE });
	}).pipe(Effect.withSpan("BlobDeletions.deleteQueued"));
