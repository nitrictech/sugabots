export * as ThreadFiles from "./thread-files.ts";

import { and, eq, isNotNull } from "drizzle-orm";
import { Config, Context, Data, Effect, Layer, Option, Schema, Stream } from "effect";
import { BlobStore } from "../../blob-store/blob-store.ts";
import { query, serviceOperations } from "../../database/database.ts";
import { threadFile } from "../../database/schema.ts";
import { Ids, isUuid } from "../../ids/ids.ts";

/**
 * The only reader and writer of `thread_file`: files in a thread, which only
 * that thread's agents can read. A file goes when its thread does.
 */
export interface Interface {
	/**
	 * Keeps `content` as a file in the thread. Fails with `FileTooLarge` when
	 * it is over `THREAD_FILE_MAX_BYTES` or what the blob store keeps, and with
	 * whatever `content.stream` fails with.
	 */
	readonly write: <E>(file: {
		threadId: string;
		/** The call whose result `content` is. */
		toolCallId?: string;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<FileDescription, E | FileTooLarge | BlobStore.Failure>;
	/**
	 * The file. Fails with `FileNotFound` when no file in the thread has that
	 * id, including when `fileId` is not an id at all. The stream fails with
	 * `FileNotFound` if the thread is deleted while it is read.
	 */
	readonly read: (file: {
		threadId: string;
		fileId: string;
	}) => Effect.Effect<
		FileDescription & { stream: Stream.Stream<Uint8Array, FileNotFound | BlobStore.Failure> },
		FileNotFound | BlobStore.Failure
	>;
	/** The files in the thread kept as tool calls' results: each call's file id, by the call's id. */
	readonly resultFiles: (threadId: string) => Effect.Effect<ReadonlyMap<string, string>>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ThreadFiles") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadFiles");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const maxFileBytes = yield* Config.option(maxFileBytesConfig);
	return Service.of({
		write: ({ threadId, toolCallId, content }) =>
			operation(
				"write",
				Effect.gen(function* () {
					const { contentType } = content;
					const stream = Option.match(maxFileBytes, {
						onNone: () => content.stream,
						onSome: (maxSize) => BlobStore.atMost(content.stream, maxSize),
					});
					const id = yield* ids.next;
					const key = fileKey(threadId, id);
					// The blob first: a row is never without its blob. A row that then
					// fails to insert would leave a blob nothing reads, so it is removed;
					// if that fails too, it goes with the thread's folder.
					const { size } = yield* blobs.put(key, { stream, contentType }).pipe(
						Effect.catchIf(
							(error) => error instanceof BlobStore.TooLarge,
							({ maxSize }) => new FileTooLarge({ maxSize }),
						),
					);
					yield* query((db) =>
						db.insert(threadFile).values({ id, threadId, toolCallId, contentType, size }),
					).pipe(Effect.onError(() => blobs.delete(key).pipe(Effect.ignore)));
					return { id, contentType, size };
				}),
			),
		read: ({ threadId, fileId }) =>
			operation(
				"read",
				Effect.gen(function* () {
					// The id comes from the model, and Postgres rejects a uuid
					// comparison against anything that is not one.
					if (!isUuid(fileId)) return yield* new FileNotFound({ fileId });
					const [file] = yield* query((db) =>
						db
							.select({ id: threadFile.id })
							.from(threadFile)
							.where(and(eq(threadFile.id, fileId), eq(threadFile.threadId, threadId))),
					);
					if (!file) return yield* new FileNotFound({ fileId });
					// A row is never without its blob, as `write` puts the blob first.
					const stored = yield* blobs
						.get(fileKey(threadId, file.id))
						.pipe(Effect.catchTag("BlobNotFound", Effect.die));
					const stream = stored.stream.pipe(
						Stream.catchTag("BlobNotFound", () => Stream.fail(new FileNotFound({ fileId }))),
					);
					return { id: file.id, ...stored, stream };
				}),
			),
		resultFiles: (threadId) =>
			operation(
				"resultFiles",
				Effect.gen(function* () {
					const rows = yield* query((db) =>
						db
							.select({ id: threadFile.id, toolCallId: threadFile.toolCallId })
							.from(threadFile)
							.where(and(eq(threadFile.threadId, threadId), isNotNull(threadFile.toolCallId))),
					);
					return new Map(
						rows.flatMap(({ id, toolCallId }) => (toolCallId ? [[toolCallId, id]] : [])),
					);
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * The largest file kept, from `THREAD_FILE_MAX_BYTES`, below what the blob
 * store keeps. Unset, the blob store's limit is the only one.
 */
const maxFileBytesConfig = Config.schema(
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	"THREAD_FILE_MAX_BYTES",
);

export interface FileDescription {
	id: string;
	contentType: string;
	/** In bytes. */
	size: number;
}

export class FileNotFound extends Data.TaggedError("ThreadFileNotFound")<{
	fileId: string;
}> {}

export class FileTooLarge extends Data.TaggedError("ThreadFileTooLarge")<{
	/** The largest size kept, in bytes. */
	maxSize: number;
}> {}

/**
 * Under the thread's folder, `threads/<threadId>`, which the
 * `thread_blob_deletion` trigger queues for deletion with the thread.
 */
function fileKey(threadId: string, fileId: string): BlobStore.Key {
	return BlobStore.key("threads", threadId, "files", fileId);
}
