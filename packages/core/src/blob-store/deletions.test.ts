import { eq } from "drizzle-orm";
import { Duration, Effect, type Layer } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
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
		await onDatabase((db) => db.insert(blobDeletion).values({ prefix, dueAt: new Date(0) }));
		return prefix;
	};
	const queued = (prefix: BlobStore.Key) =>
		onDatabase((db) => db.select().from(blobDeletion).where(eq(blobDeletion.prefix, prefix)));

	/** A store whose deletion of `held` waits until released, and deletes everything else at once. */
	const storeHolding = (held: BlobStore.Key) => {
		const started = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		onTestFinished(() => released.resolve());
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
	const deleteQueuedWith = (store: Layer.Layer<BlobStore.Service>, now = Date.UTC(2026, 0, 1)) =>
		runOnPostgres(
			TestClock.setTime(now).pipe(
				Effect.andThen(BlobDeletions.deleteQueued),
				Effect.provide([store, TestClock.layer()]),
			),
		);

	it("deletes a folder's blobs with its queue row unlocked, and forgets the row once they're gone", async () => {
		const prefix = await queueFolder();
		const store = storeHolding(prefix);
		const working = deleteQueuedWith(store.layer);
		try {
			await Promise.race([
				store.started,
				working.then(() => {
					throw new Error("The sweep did not start deleting the folder");
				}),
			]);
			const lockingTheRow = holdTransaction(
				query((db) =>
					db
						.select({ id: blobDeletion.id })
						.from(blobDeletion)
						.where(eq(blobDeletion.prefix, prefix))
						.for("update", { noWait: true }),
				),
			);
			try {
				expect(await lockingTheRow.held).toHaveLength(1);
			} finally {
				await lockingTheRow.release().catch(() => undefined);
			}
		} finally {
			store.release();
			await working;
		}
		expect(await queued(prefix)).toEqual([]);
	});

	it("takes over a folder only after its claim expires and leaves the new claim intact", async () => {
		const prefix = await queueFolder();
		const first = storeHolding(prefix);
		const working = deleteQueuedWith(first.layer);
		const second = storeHolding(prefix);
		let takingOver: Promise<void> | undefined;
		try {
			await Promise.race([
				first.started,
				working.then(() => {
					throw new Error("The sweep did not claim the folder");
				}),
			]);
			takingOver = deleteQueuedWith(second.layer);
			expect(
				await Promise.race([
					second.started.then(() => "deleted"),
					takingOver.then(() => "skipped"),
				]),
			).toBe("skipped");

			takingOver = deleteQueuedWith(
				second.layer,
				Date.UTC(2026, 0, 1) + Duration.toMillis(Duration.hours(1)),
			);
			await Promise.race([
				second.started,
				takingOver.then(() => {
					throw new Error("The expired claim was not taken over");
				}),
			]);
			first.release();
			await working;
			expect(await queued(prefix)).toHaveLength(1);
		} finally {
			first.release();
			second.release();
			await Promise.all([working, takingOver]);
		}
		expect(await queued(prefix)).toEqual([]);
	});
});
