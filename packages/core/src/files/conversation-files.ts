export * as ConversationFiles from "./conversation-files.ts";

import { type FilePart, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { type DomainError, userText } from "@sugabots/errors";
import {
	and,
	count,
	eq,
	inArray,
	isNotNull,
	lt,
	notInArray,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
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
import { BlobStore } from "../blob-store/blob-store.ts";
import { type AttachedFileRow, loadFileParts } from "../conversations/repository/file-parts.ts";
import { afterCommit, query, serviceOperations, transaction } from "../database/database.ts";
import { file, message, WRITTEN_FILE_KINDS } from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";

/**
 * The files kept whole in a conversation, which its bots read, and people too
 * when a conversation serves them: every `file` but those bots write in
 * versions, which `files.ts` keeps. Their only writer, and their reader but
 * for the files messages show, which `repository/file-parts.ts` reads. A file
 * goes when its conversation does.
 *
 * A file is a tool's result, kept with `write`, a person's upload, kept with
 * `upload`, or a bot's attachment to its reply, kept with `withReplyFile`. An
 * upload stays unsent, and unreadable, until it is attached to a message; one
 * never attached is removed by `removeUnsentUploads`.
 */
export interface Interface {
	/**
	 * Keeps `content` as a file in the conversation. Fails with `FileTooLarge` when
	 * it is over `THREAD_FILE_MAX_BYTES` or what the blob store keeps, and with
	 * whatever `content.stream` fails with.
	 */
	readonly write: <E>(file: {
		conversationId: string;
		/** The call whose result `content` is. */
		toolCallId?: string;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<FileDescription, E | FileTooLarge | BlobStore.Failure>;
	/**
	 * Keeps `content` as a file `uploaderId` uploaded to the conversation, unsent
	 * until it is attached to a message. Fails as `write` does, with
	 * `FileTooLarge` past `maxSize` bytes, and with `TooManyUnsentUploads`,
	 * keeping nothing, when the uploader already has `maxUnsent` unsent
	 * uploads in the conversation. Uploads at the same moment may each pass that
	 * check, so it bounds them only roughly.
	 */
	readonly upload: <E>(file: {
		conversationId: string;
		uploaderId: string;
		name: string;
		maxSize: number;
		maxUnsent: number;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<Upload, E | FileTooLarge | TooManyUnsentUploads | BlobStore.Failure>;
	/**
	 * The file. Fails with `FileNotFound` when no file in the conversation has that
	 * id, including when `fileId` is not an id at all, and for an unsent
	 * upload. The stream fails with `FileNotFound` if the conversation is deleted
	 * while it is read.
	 */
	readonly read: (file: {
		conversationId: string;
		fileId: string;
	}) => Effect.Effect<StoredFile, FileNotFound | BlobStore.Failure>;
	/**
	 * A file attached to a message in the conversation, as `read` gives it. Fails
	 * with `FileNotFound` for any other file, such as a tool call's result.
	 */
	readonly readMessageFile: (file: {
		conversationId: string;
		fileId: string;
	}) => Effect.Effect<StoredFile, FileNotFound | BlobStore.Failure>;
	/**
	 * Attaches the uploads `fileIds` to `messageId` in the order listed, and
	 * returns them in that order. Each must be one of `uploaderId`'s unsent
	 * uploads in the conversation; when any is not, including one removed for
	 * waiting too long, fails with `UploadsNotFound` and attaches none.
	 */
	readonly attach: (input: {
		conversationId: string;
		messageId: string;
		uploaderId: string;
		fileIds: readonly string[];
	}) => Effect.Effect<readonly AttachedFileRow[], UploadsNotFound>;
	/** The files in the conversation kept as tool calls' results: each call's file id, by the call's id. */
	readonly resultFiles: (conversationId: string) => Effect.Effect<ReadonlyMap<string, string>>;
	/**
	 * Puts `content` in the blob store as a file for a bot's reply
	 * `messageId`, then runs `use` with it, for `use` to attach with
	 * `attachToReply`. The blob is written before `use` runs, so nothing `use`
	 * locks waits on it, and removed if `use` fails. Run outside a transaction:
	 * one that rolls back after `use` succeeds would leave the blob until the
	 * conversation goes.
	 */
	readonly withReplyFile: <A, E, R>(
		file: {
			conversationId: string;
			messageId: string;
			name: string;
			contentType: string;
			content: Uint8Array;
		},
		use: (stored: StoredReplyFile) => Effect.Effect<A, E, R>,
	) => Effect.Effect<A, E | FileTooLarge | BlobStore.Failure, R>;
	/**
	 * Attaches `stored` to its reply, after the reply's other files. Fails with
	 * `TooManyReplyFiles` once the reply carries as many as a message can.
	 */
	readonly attachToReply: (stored: StoredReplyFile) => Effect.Effect<FilePart, TooManyReplyFiles>;
	/** The files a bot attached to its reply `messageId`, in the order attached. */
	readonly replyAttachments: (messageId: string) => Effect.Effect<readonly FilePart[]>;
	/**
	 * Removes the files a bot attached to its reply `messageId`, as when the
	 * reply starts again. Their blobs go once the enclosing transaction commits.
	 */
	readonly removeReplyAttachments: (reply: {
		conversationId: string;
		messageId: string;
	}) => Effect.Effect<void>;
	/**
	 * Removes `fileId` when it is one of `uploaderId`'s unsent uploads in the
	 * conversation, such as one taken off a message before it was sent. Anything
	 * else, a file already gone included, is left as it is.
	 */
	readonly removeUnsentUpload: (file: {
		conversationId: string;
		uploaderId: string;
		fileId: string;
	}) => Effect.Effect<void>;
	/**
	 * Removes every upload still unsent `unsentFor` after it was uploaded, and
	 * returns how many. A blob that cannot be removed is left to go with its
	 * conversation's folder.
	 */
	readonly removeUnsentUploads: (unsentFor: Duration.Duration) => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ConversationFiles",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ConversationFiles");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const maxFileBytes = yield* Config.option(maxFileBytesConfig);

	/**
	 * Puts `content` in the blob store as a new file in the conversation, with no row
	 * yet: a row is never without its blob.
	 */
	const putBlob = <E>(
		conversationId: string,
		content: BlobStore.Content<E>,
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
			const { size } = yield* blobs.put(fileKey(conversationId, id), { stream, contentType }).pipe(
				Effect.catchIf(
					(error) => error instanceof BlobStore.TooLarge,
					({ maxSize }) => new FileTooLarge({ maxSize }),
				),
			);
			return { id, contentType, size } satisfies FileDescription;
		});

	/** Keeps `content` as a new file in the conversation, its row saying where it came from. */
	const keep = <E>(
		conversationId: string,
		content: BlobStore.Content<E>,
		source: FileSource,
		maxSize = Number.POSITIVE_INFINITY,
	) =>
		Effect.gen(function* () {
			const kept = yield* putBlob(conversationId, content, maxSize);
			yield* query((db) =>
				db.insert(file).values({ ...kept, conversationId: conversationId, ...source }),
			).pipe(Effect.onError(() => removeBlob(conversationId, kept.id)));
			return kept;
		});

	/** Removes a file's blob, once its row is gone or was never kept; one that cannot be removed goes with the conversation's folder. */
	const removeBlob = (conversationId: string, fileId: string) =>
		blobs
			.delete(fileKey(conversationId, fileId))
			.pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Removing a conversation file's blob failed", cause),
				),
			);

	/** The file `fileId` in the conversation, when its row also matches `which`. */
	const readWhere = (conversationId: string, fileId: string, which: SQLWrapper) =>
		Effect.gen(function* () {
			// The id comes from the model or a URL, and Postgres rejects a uuid
			// comparison against anything that is not one.
			if (!isUuid(fileId)) return yield* new FileNotFound({ fileId });
			const [found] = yield* query((db) =>
				db
					.select({ id: file.id, name: file.name })
					.from(file)
					.where(
						and(
							eq(file.id, fileId),
							eq(file.conversationId, conversationId),
							keptInConversation,
							which,
						),
					),
			);
			if (!found) return yield* new FileNotFound({ fileId });
			// A row is never without its blob, as `keep` puts the blob first.
			const stored = yield* blobs
				.get(fileKey(conversationId, found.id))
				.pipe(Effect.catchTag("BlobNotFound", Effect.die));
			const stream = stored.stream.pipe(
				Stream.catchTag("BlobNotFound", () => Stream.fail(new FileNotFound({ fileId }))),
			);
			return { id: found.id, name: found.name ?? undefined, ...stored, stream };
		});

	return Service.of({
		write: ({ conversationId, toolCallId, content }) =>
			operation("write", keep(conversationId, content, { kind: "tool_result", toolCallId })),
		upload: ({ conversationId, uploaderId, name, maxSize, maxUnsent, content }) =>
			operation(
				"upload",
				Effect.gen(function* () {
					const [{ unsent } = { unsent: 0 }] = yield* query((db) =>
						db
							.select({ unsent: count() })
							.from(file)
							.where(
								and(
									eq(file.conversationId, conversationId),
									eq(file.uploaderId, uploaderId),
									unsentUpload,
								),
							),
					);
					if (unsent >= maxUnsent) return yield* new TooManyUnsentUploads({ maxUnsent });
					const kept = yield* keep(
						conversationId,
						content,
						{ kind: "upload", uploaderId, name },
						maxSize,
					);
					return { ...kept, name };
				}),
			),
		read: ({ conversationId, fileId }) =>
			operation("read", readWhere(conversationId, fileId, sql`not ${unsentUpload}`)),
		readMessageFile: ({ conversationId, fileId }) =>
			operation("readMessageFile", readWhere(conversationId, fileId, isNotNull(file.messageId))),
		attach: ({ conversationId, messageId, uploaderId, fileIds }) =>
			operation(
				"attach",
				transaction(
					Effect.gen(function* () {
						const wanted = [...new Set(fileIds)];
						// The ids come from the sender, and Postgres rejects a uuid
						// comparison against anything that is not one.
						if (!wanted.every(isUuid)) return yield* new UploadsNotFound();
						const listedPosition = sql`case ${file.id} ${sql.join(
							wanted.map((id, position) => sql`when ${id}::uuid then ${position}::integer`),
							sql` `,
						)} end`;
						const attached = yield* query((db) =>
							db
								.update(file)
								.set({ messageId, position: listedPosition })
								.where(
									and(
										inArray(file.id, wanted),
										eq(file.conversationId, conversationId),
										eq(file.uploaderId, uploaderId),
										unsentUpload,
									),
								)
								.returning({
									id: file.id,
									name: file.name,
									contentType: file.contentType,
									size: file.size,
								}),
						);
						// Failing rolls back the ones that were found.
						if (attached.length !== wanted.length) return yield* new UploadsNotFound();
						const listed = new Map(attached.map((one) => [one.id, one]));
						return wanted.flatMap((id) => listed.get(id) ?? []);
					}),
				),
			),
		resultFiles: (conversationId) =>
			operation(
				"resultFiles",
				Effect.gen(function* () {
					const rows = yield* query((db) =>
						db
							.select({ id: file.id, toolCallId: file.toolCallId })
							.from(file)
							.where(and(eq(file.conversationId, conversationId), isNotNull(file.toolCallId))),
					);
					return new Map(
						rows.flatMap(({ id, toolCallId }) => (toolCallId ? [[toolCallId, id]] : [])),
					);
				}),
			),
		withReplyFile: ({ conversationId, messageId, name, contentType, content }, use) =>
			operation(
				"withReplyFile",
				Effect.gen(function* () {
					const kept = yield* putBlob(conversationId, {
						stream: Stream.succeed(content),
						contentType,
					});
					const stored = { ...kept, conversationId, messageId, name } as StoredReplyFile;
					return yield* use(stored).pipe(Effect.onError(() => removeBlob(conversationId, kept.id)));
				}),
			),
		attachToReply: (stored) =>
			operation(
				"attachToReply",
				transaction(
					Effect.gen(function* () {
						const { id, conversationId, messageId, name, contentType, size } = stored;
						// Locked, so files attached at once each take the next place, and the count holds.
						yield* query((db) =>
							db
								.select({ id: message.id })
								.from(message)
								.where(eq(message.id, messageId))
								.for("update"),
						);
						const [attached] = yield* query((db) =>
							db
								.select({ files: count() })
								.from(file)
								.where(and(eq(file.messageId, messageId), eq(file.kind, "bot_attachment"))),
						);
						const position = attached?.files ?? 0;
						if (position >= MAX_ATTACHMENTS_PER_MESSAGE) return yield* new TooManyReplyFiles();
						yield* query((db) =>
							db.insert(file).values({
								id,
								conversationId: conversationId,
								contentType,
								size,
								kind: "bot_attachment",
								name,
								messageId,
								position,
							}),
						);
						return { type: "file", id, name, contentType, size } as const;
					}),
				),
			),
		replyAttachments: (messageId) =>
			operation(
				"replyAttachments",
				query((db) => loadFileParts(db, [messageId])).pipe(
					Effect.map((byMessage) => byMessage.get(messageId) ?? []),
				),
			),
		removeReplyAttachments: ({ conversationId, messageId }) =>
			operation(
				"removeReplyAttachments",
				Effect.gen(function* () {
					const removed = yield* query((db) =>
						db
							.delete(file)
							.where(and(eq(file.messageId, messageId), eq(file.kind, "bot_attachment")))
							.returning({ id: file.id }),
					);
					yield* afterCommit(
						Effect.forEach(removed, ({ id }) => removeBlob(conversationId, id), { discard: true }),
					);
				}),
			),
		removeUnsentUpload: ({ conversationId, uploaderId, fileId }) =>
			operation(
				"removeUnsentUpload",
				Effect.gen(function* () {
					// The id comes from the uploader's client, and Postgres rejects a
					// uuid comparison against anything that is not one.
					if (!isUuid(fileId)) return;
					const removed = yield* query((db) =>
						db
							.delete(file)
							.where(
								and(
									eq(file.id, fileId),
									eq(file.conversationId, conversationId),
									eq(file.uploaderId, uploaderId),
									unsentUpload,
								),
							)
							.returning({ id: file.id }),
					);
					if (removed.length > 0) yield* removeBlob(conversationId, fileId);
				}),
			),
		removeUnsentUploads: (unsentFor) =>
			operation(
				"removeUnsentUploads",
				Effect.gen(function* () {
					// Measured on the database's clock, which stamped `created_at`.
					const removed = yield* query((db) =>
						db
							.delete(file)
							.where(
								and(
									unsentUpload,
									lt(
										file.createdAt,
										sql`now() - make_interval(secs => ${Duration.toSeconds(unsentFor)})`,
									),
								),
							)
							.returning({ id: file.id, conversationId: file.conversationId }),
					);
					yield* Effect.forEach(
						removed,
						({ id, conversationId }) => removeBlob(conversationId, id),
						{
							discard: true,
						},
					);
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

declare const storedReplyFile: unique symbol;

/**
 * A file for a bot's reply whose blob `withReplyFile` has written, for
 * `attachToReply` to attach. Only `withReplyFile` makes one.
 */
export interface StoredReplyFile extends FileDescription {
	readonly [storedReplyFile]: true;
	readonly conversationId: string;
	readonly messageId: string;
	readonly name: string;
}

/** A file a person uploaded, with the name it had on their computer. */
export interface Upload extends FileDescription {
	name: string;
}

/**
 * A file kept here, as one blob in the conversation's folder: not a file a
 * bot wrote, whose versions `files.ts` keeps.
 */
const keptInConversation = notInArray(file.kind, [...WRITTEN_FILE_KINDS]);

/** An upload not yet attached to a message, which only its uploader knows of. */
const unsentUpload = sql`(${file.kind} = 'upload' and ${file.messageId} is null)`;

/** Which kind of file a row is, with the columns that kind sets. */
type FileSource =
	| { kind: "tool_result"; toolCallId: string | undefined }
	| { kind: "upload"; uploaderId: string; name: string }
	| { kind: "bot_attachment"; name: string; messageId: string; position: number };

export class FileNotFound
	extends Data.TaggedError("ConversationFileNotFound")<{
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
		/** How many unsent uploads one person may have in a conversation. */
		maxUnsent: number;
	}>
	implements UserFacing
{
	get userMessage() {
		return userText`You can have ${this.maxUnsent} files waiting to be sent at most. Send or remove some first`;
	}
}

export class FileTooLarge
	extends Data.TaggedError("FileTooLarge")<{
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

export class TooManyReplyFiles extends Data.TaggedError("TooManyReplyFiles") implements UserFacing {
	get userMessage() {
		return userText`A reply can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`;
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
 * Under the thread's folder, `threads/<conversationId>`, which the
 * `conversation_blob_deletion` trigger queues for deletion with the conversation.
 */
function fileKey(conversationId: string, fileId: string): BlobStore.Key {
	return BlobStore.key("threads", conversationId, "files", fileId);
}
