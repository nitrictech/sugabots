import { asc, eq, like, sql } from "drizzle-orm";
import { Effect, Option, Stream } from "effect";
import { Database, query, serviceOperations } from "../../database/database.ts";
import { blob } from "../../database/schema.ts";
import { BlobStore } from "../blob-store.ts";

/**
 * Blobs in the application database's `blob` table. Never fails with a
 * `Failure`: like every other query, one that fails is a defect, since
 * without its database the application can do nothing else either.
 *
 * `put` gathers a blob into memory to insert it as one value, while `get`
 * reads it back `READ_CHUNK_BYTES` at a time.
 */
export const fromPostgres = Effect.gen(function* () {
	const operation = yield* serviceOperations<BlobStore.Interface>("BlobStore");
	const database = yield* Database;
	return {
		put: (key, { stream, contentType }) =>
			operation(
				"put",
				Effect.gen(function* () {
					const bytes = yield* collect(BlobStore.atMost(stream, MAX_BYTES));
					const content = { bytes, contentType, size: bytes.byteLength };
					yield* query((db) =>
						db
							.insert(blob)
							.values({ key, ...content })
							.onConflictDoUpdate({ target: blob.key, set: content }),
					);
					return { size: content.size };
				}),
			),
		get: (key) =>
			operation(
				"get",
				Effect.gen(function* () {
					const [found] = yield* query((db) =>
						db
							.select({ contentType: blob.contentType, size: blob.size })
							.from(blob)
							.where(eq(blob.key, key)),
					);
					if (!found) return yield* new BlobStore.NotFound({ key });
					const stream = Stream.paginate(0, (offset: number) =>
						Effect.map(readChunk(key, offset), (chunk) => {
							const next = offset + chunk.byteLength;
							// A short chunk ends what is stored now, short of `found.size` when
							// the blob was replaced by a smaller one meanwhile.
							const more = chunk.byteLength === READ_CHUNK_BYTES && next < found.size;
							return [[chunk], more ? Option.some(next) : Option.none()] as const;
						}),
					).pipe(Stream.provideService(Database, database));
					return { ...found, stream };
				}),
			),
		delete: (key) =>
			operation(
				"delete",
				query((db) => db.delete(blob).where(eq(blob.key, key))),
			),
		list: (prefix) =>
			operation(
				"list",
				query((db) =>
					db
						.select({ key: blob.key, contentType: blob.contentType, size: blob.size })
						.from(blob)
						.where(like(blob.key, underPattern(prefix)))
						.orderBy(asc(blob.key)),
				),
			),
		deletePrefix: (prefix) =>
			operation(
				"deletePrefix",
				query((db) => db.delete(blob).where(like(blob.key, underPattern(prefix)))),
			),
	} satisfies BlobStore.Interface;
});

/**
 * The largest blob kept. `put` holds a blob in memory whole to insert it, so
 * this bounds what one upload costs the server; larger files belong in an
 * external blob store.
 */
const MAX_BYTES = 100 * 1024 * 1024;

/**
 * How much of a blob one query reads. Reading a large `bytea` whole crashes
 * the process: the driver receives it hex-encoded, as a string over
 * JavaScript's length limit.
 */
const READ_CHUNK_BYTES = 8 * 1024 * 1024;

/** The `READ_CHUNK_BYTES` of `key`'s blob from `offset`, failing if it has gone. */
function readChunk(key: BlobStore.Key, offset: number) {
	return Effect.flatMap(
		query((db) =>
			db
				.select({
					// Postgres counts from 1.
					bytes: sql<Buffer>`substring(${blob.bytes} from ${offset + 1} for ${READ_CHUNK_BYTES})`,
				})
				.from(blob)
				.where(eq(blob.key, key)),
		),
		([found]) => (found ? Effect.succeed(found.bytes) : new BlobStore.NotFound({ key })),
	);
}

function collect<E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<Buffer, E> {
	return Effect.map(Stream.runCollect(stream), (chunks) => Buffer.concat(chunks));
}

/** The `LIKE` pattern for every key under `prefix`, with its wildcards escaped. */
function underPattern(prefix: BlobStore.Key): string {
	return `${prefix.replace(/[\\%_]/g, "\\$&")}/%`;
}
