import { eq } from "drizzle-orm";
import { Effect, type Layer } from "effect";
import { afterAll, describe, expect, it } from "vitest";
import { query } from "../database/database.ts";
import { blobDeletion } from "../database/schema.ts";
import { closeDatabase, holdTransaction, onDatabase, runOnPostgres } from "../database/testing.ts";
import { unimplemented } from "../testing.ts";
import { BlobStore } from "./blob-store.ts";
import { BlobDeletions } from "./deletions.ts";

afterAll(closeDatabase);

describe.skipIf(!process.env.DATABASE_URL)("deleting queued blobs, against Postgres", () => {
	/** A folder queued for deletion, as deleting what owns it queues it. */
	const queueFolder = async () => {
		const prefix = BlobStore.key("chats", crypto.randomUUID());
		await onDatabase((db) => db.insert(blobDeletion).values({ prefix }));
		return prefix;
	};
	const queued = (prefix: BlobStore.Key) =>
		onDatabase((db) => db.select().from(blobDeletion).where(eq(blobDeletion.prefix, prefix)));

	/** A store whose deletion of `held` waits until released, and deletes everything else at once. */
	const storeHolding = (held: BlobStore.Key) => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const layer = unimplemented(BlobStore.Service, {
			delete: () => Effect.void,
			deletePrefix: (prefix) =>
				prefix === held
					? Effect.promise(() => {
							started.resolve();
							return released.promise;
						})
					: Effect.void,
		});
		return { layer, started: started.promise, release: () => released.resolve() };
	};
	const deleteQueuedWith = (store: Layer.Layer<BlobStore.Service>) =>
		runOnPostgres(BlobDeletions.deleteQueued.pipe(Effect.provide(store)));

	it("deletes a folder's blobs with its queue row unlocked, and forgets the row once they're gone", async () => {
		const prefix = await queueFolder();
		const store = storeHolding(prefix);

		const working = deleteQueuedWith(store.layer);
		await store.started;
		const lockingTheRow = holdTransaction(
			query((db) =>
				db
					.select({ id: blobDeletion.id })
					.from(blobDeletion)
					.where(eq(blobDeletion.prefix, prefix))
					.for("update", { noWait: true }),
			),
		);
		const rowFree = await lockingTheRow.held.then(
			() => true,
			() => false,
		);
		await lockingTheRow.release().catch(() => undefined);
		store.release();
		await working;

		expect(rowFree).toBe(true);
		expect(await queued(prefix)).toEqual([]);
	});

	it("leaves a folder another worker has claimed until its claim runs out", async () => {
		const prefix = await queueFolder();
		const store = storeHolding(prefix);
		const working = deleteQueuedWith(store.layer);
		await store.started;

		// Another worker comes by while the first is still deleting.
		await deleteQueuedWith(storeHolding(BlobStore.key("unused")).layer);
		const whileClaimed = await queued(prefix);
		store.release();
		await working;

		expect(whileClaimed).toHaveLength(1);
		expect(await queued(prefix)).toEqual([]);
	});
});
