export * as ThreadFiles from "./thread-files.ts";

import { type DomainError, userText } from "@sugabots/errors";
import { and, count, eq, inArray, isNotNull, lt, not, sql } from "drizzle-orm";
import {
	Config,
	Context,
	Data,
	Duration,
	Effect,
	ErrorReporter,
	Layer,
	Option,
	Schema,
	Stream,
} from "effect";
import { BlobStore } from "../../blob-store/blob-store.ts";
import { query, serviceOperations, transaction } from "../../database/database.ts";
import { threadFile } from "../../database/schema.ts";
import { Ids, isUuid } from "../../ids/ids.ts";
import type { UserFacing } from "../../user-message.ts";
import type { AttachedFileRow } from "../threads/file-parts.ts";

/**
 * The only writer of `thread_file`, and its reader but for the files messages
 * show, which `threads/file-parts.ts` reads: files in a thread, which its
 * agents read, and people too when a chat serves them. A file goes when its
 * thread does.
 *
 * A file is a tool's result, kept with `write`, or a person's upload, kept
 * with `upload`. An upload stays unsent, and unreadable, until it is attached
 * to a message; one never attached is removed by `removeUnsentUploads`.
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
	 * Keeps `content` as a file `uploaderId` uploaded to the thread, unsent
	 * until it is attached to a message. Fails as `write` does, with
	 * `FileTooLarge` past `maxSize` bytes, and with `TooManyUnsentUploads`,
	 * keeping nothing, when the uploader already has `maxUnsent` unsent
	 * uploads in the thread. Uploads at the same moment may each pass that
	 * check, so it bounds them only roughly.
	 */
	readonly upload: <E>(file: {
		threadId: string;
		uploaderId: string;
		name: string;
		maxSize: number;
		maxUnsent: number;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<Upload, E | FileTooLarge | TooManyUnsentUploads | BlobStore.Failure>;
	/**
	 * The file. Fails with `FileNotFound` when no file in the thread has that
	 * id, including when `fileId` is not an id at all, and for an unsent
	 * upload. The stream fails with `FileNotFound` if the thread is deleted
	 * while it is read.
	 */
	readonly read: (file: {
		threadId: string;
		fileId: string;
	}) => Effect.Effect<StoredFile, FileNotFound | BlobStore.Failure>;
	/**
	 * Attaches the uploads `fileIds` to `messageId` in the order listed, and
	 * returns them in that order. Each must be one of `uploaderId`'s unsent
	 * uploads in the thread; when any is not, including one removed for
	 * waiting too long, fails with `UploadsNotFound` and attaches none.
	 */
	readonly attach: (input: {
		threadId: string;
		messageId: string;
		uploaderId: string;
		fileIds: readonly string[];
	}) => Effect.Effect<readonly AttachedFileRow[], UploadsNotFound>;
	/** The files in the thread kept as tool calls' results: each call's file id, by the call's id. */
	readonly resultFiles: (threadId: string) => Effect.Effect<ReadonlyMap<string, string>>;
	/**
	 * Removes `fileId` when it is one of `uploaderId`'s unsent uploads in the
	 * thread, such as one taken off a message before it was sent. Anything
	 * else, a file already gone included, is left as it is.
	 */
	readonly removeUnsentUpload: (file: {
		threadId: string;
		uploaderId: string;
		fileId: string;
	}) => Effect.Effect<void>;
	/**
	 * Removes every upload still unsent `unsentFor` after it was uploaded, and
	 * returns how many. A blob that cannot be removed is left to go with its
	 * thread's folder.
	 */
	readonly removeUnsentUploads: (unsentFor: Duration.Duration) => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/ThreadFiles") {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ThreadFiles");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const maxFileBytes = yield* Config.option(maxFileBytesConfig);

	/**
	 * Keeps `content` as a new file in the thread, its row saying where it came
	 * from. The blob first: a row is never without its blob. A row that then
	 * fails to insert would leave a blob nothing reads, so it is removed; if
	 * that fails too, it goes with the thread's folder.
	 */
	const keep = <E>(
		threadId: string,
		content: BlobStore.Content<E>,
		source: FileSource,
		maxSize = Number.POSITIVE_INFINITY,
	) =>
		Effect.gen(function* () {
			const { contentType } = content;
			const limit = Math.min(
				maxSize,
				Option.getOrElse(maxFileBytes, () => Number.POSITIVE_INFINITY),
			);
			const stream =
				limit === Number.POSITIVE_INFINITY
					? content.stream
					: BlobStore.atMost(content.stream, limit);
			const id = yield* ids.next;
			const key = fileKey(threadId, id);
			const { size } = yield* blobs.put(key, { stream, contentType }).pipe(
				Effect.catchIf(
					(error) => error instanceof BlobStore.TooLarge,
					({ maxSize }) => new FileTooLarge({ maxSize }),
				),
			);
			yield* query((db) =>
				db.insert(threadFile).values({ id, threadId, contentType, size, ...source }),
			).pipe(Effect.onError(() => blobs.delete(key).pipe(Effect.ignore)));
			return { id, contentType, size };
		});

	/** Removes an unsent upload's blob, once its row is gone; one that cannot be removed goes with the thread's folder. */
	const removeUploadBlob = (threadId: string, fileId: string) =>
		blobs
			.delete(fileKey(threadId, fileId))
			.pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Removing an unsent upload's blob failed", cause),
				),
			);

	return Service.of({
		write: ({ threadId, toolCallId, content }) =>
			operation("write", keep(threadId, content, { kind: "tool_result", toolCallId })),
		upload: ({ threadId, uploaderId, name, maxSize, maxUnsent, content }) =>
			operation(
				"upload",
				Effect.gen(function* () {
					const [{ unsent } = { unsent: 0 }] = yield* query((db) =>
						db
							.select({ unsent: count() })
							.from(threadFile)
							.where(
								and(
									eq(threadFile.threadId, threadId),
									eq(threadFile.uploaderId, uploaderId),
									unsentUpload,
								),
							),
					);
					if (unsent >= maxUnsent) return yield* new TooManyUnsentUploads({ maxUnsent });
					const file = yield* keep(
						threadId,
						content,
						{ kind: "upload", uploaderId, name },
						maxSize,
					);
					return { ...file, name };
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
							.select({ id: threadFile.id, name: threadFile.name })
							.from(threadFile)
							.where(
								and(
									eq(threadFile.id, fileId),
									eq(threadFile.threadId, threadId),
									not(unsentUpload),
								),
							),
					);
					if (!file) return yield* new FileNotFound({ fileId });
					// A row is never without its blob, as `keep` puts the blob first.
					const stored = yield* blobs
						.get(fileKey(threadId, file.id))
						.pipe(Effect.catchTag("BlobNotFound", Effect.die));
					const stream = stored.stream.pipe(
						Stream.catchTag("BlobNotFound", () => Stream.fail(new FileNotFound({ fileId }))),
					);
					return { id: file.id, name: file.name ?? undefined, ...stored, stream };
				}),
			),
		attach: ({ threadId, messageId, uploaderId, fileIds }) =>
			operation(
				"attach",
				transaction(
					Effect.gen(function* () {
						const wanted = [...new Set(fileIds)];
						// The ids come from the sender, and Postgres rejects a uuid
						// comparison against anything that is not one.
						if (!wanted.every(isUuid)) return yield* new UploadsNotFound();
						const listedPosition = sql`case ${threadFile.id} ${sql.join(
							wanted.map((id, position) => sql`when ${id}::uuid then ${position}::integer`),
							sql` `,
						)} end`;
						const attached = yield* query((db) =>
							db
								.update(threadFile)
								.set({ messageId, position: listedPosition })
								.where(
									and(
										inArray(threadFile.id, wanted),
										eq(threadFile.threadId, threadId),
										eq(threadFile.uploaderId, uploaderId),
										unsentUpload,
									),
								)
								.returning({
									id: threadFile.id,
									name: threadFile.name,
									contentType: threadFile.contentType,
									size: threadFile.size,
								}),
						);
						// Failing rolls back the ones that were found.
						if (attached.length !== wanted.length) return yield* new UploadsNotFound();
						const listed = new Map(attached.map((file) => [file.id, file]));
						return wanted.flatMap((id) => listed.get(id) ?? []);
					}),
				),
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
		removeUnsentUpload: ({ threadId, uploaderId, fileId }) =>
			operation(
				"removeUnsentUpload",
				Effect.gen(function* () {
					// The id comes from the uploader's client, and Postgres rejects a
					// uuid comparison against anything that is not one.
					if (!isUuid(fileId)) return;
					const removed = yield* query((db) =>
						db
							.delete(threadFile)
							.where(
								and(
									eq(threadFile.id, fileId),
									eq(threadFile.threadId, threadId),
									eq(threadFile.uploaderId, uploaderId),
									unsentUpload,
								),
							)
							.returning({ id: threadFile.id }),
					);
					if (removed.length > 0) yield* removeUploadBlob(threadId, fileId);
				}),
			),
		removeUnsentUploads: (unsentFor) =>
			operation(
				"removeUnsentUploads",
				Effect.gen(function* () {
					// Measured on the database's clock, which stamped `created_at`.
					const removed = yield* query((db) =>
						db
							.delete(threadFile)
							.where(
								and(
									unsentUpload,
									lt(
										threadFile.createdAt,
										sql`now() - make_interval(secs => ${Duration.toSeconds(unsentFor)})`,
									),
								),
							)
							.returning({ id: threadFile.id, threadId: threadFile.threadId }),
					);
					yield* Effect.forEach(removed, ({ id, threadId }) => removeUploadBlob(threadId, id), {
						discard: true,
					});
					return removed.length;
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

/** A file being read: its description, its name when it is an upload, and its bytes. */
export interface StoredFile extends FileDescription {
	/** An upload's name; a tool result has none. */
	name: string | undefined;
	stream: Stream.Stream<Uint8Array, FileNotFound | BlobStore.Failure>;
}

/** A file a person uploaded, with the name it had on their computer. */
export interface Upload extends FileDescription {
	name: string;
}

/** An upload not yet attached to a message, which only its uploader knows of. */
const unsentUpload = sql`(${threadFile.kind} = 'upload' and ${threadFile.messageId} is null)`;

/** Which kind of file a row is, with the columns that kind sets. */
type FileSource =
	| { kind: "tool_result"; toolCallId: string | undefined }
	| { kind: "upload"; uploaderId: string; name: string };

export class FileNotFound
	extends Data.TaggedError("ThreadFileNotFound")<{
		fileId: string;
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`That file isn't there`;
	}
}

/**
 * A file to send is not one of the sender's unsent uploads, such as one cleared
 * for waiting too long. A domain error, so a client can tell it apart by its
 * tag rather than its wording.
 */
export class UploadsNotFound
	extends Schema.TaggedError<UploadsNotFound>()("UploadsNotFound", {})
	implements DomainError
{
	readonly isRetryable = false;
	override readonly [ErrorReporter.severity] = "Info" as const;
	override get message() {
		return "A file to send is not one of the sender's unsent uploads";
	}
	get userMessage() {
		return userText`A file to send is no longer there. Remove it and attach it again`;
	}
}

export class TooManyUnsentUploads
	extends Data.TaggedError("TooManyUnsentUploads")<{
		/** How many unsent uploads one person may have in a thread. */
		maxUnsent: number;
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`You can have ${this.maxUnsent} files waiting to be sent at most. Send or remove some first`;
	}
}

export class FileTooLarge
	extends Data.TaggedError("ThreadFileTooLarge")<{
		/** The largest size kept, in bytes. */
		maxSize: number;
	}>
	implements UserFacing
{
	get userMessage() {
		const { amount, unit } = sizeForPeople(this.maxSize);
		return userText`The file is larger than ${amount} ${unit}, the most that can be kept`;
	}
}

/** `bytes` as people read a file's size, such as 30 MB or 512 KB. */
function sizeForPeople(bytes: number): { amount: number; unit: "MB" | "KB" } {
	const mebibytes = bytes / (1024 * 1024);
	return mebibytes >= 1
		? { amount: Math.floor(mebibytes), unit: "MB" }
		: { amount: Math.max(1, Math.floor(bytes / 1024)), unit: "KB" };
}

/**
 * Under the thread's folder, `threads/<threadId>`, which the
 * `thread_blob_deletion` trigger queues for deletion with the thread.
 */
function fileKey(threadId: string, fileId: string): BlobStore.Key {
	return BlobStore.key("threads", threadId, "files", fileId);
}
