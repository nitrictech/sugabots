export { ChatFileNotFound as FileNotFound } from "@sugabots/contracts/errors/chat-reads";
export {
	FileTooLarge,
	TooManyUnsentAttachments,
	UnsentAttachmentsNotFound,
} from "@sugabots/contracts/errors/chats";
export * as ChatFileStore from "./chat-file-store.ts";

import { type FilePart, MAX_ATTACHMENTS_PER_MESSAGE } from "@sugabots/contracts";
import { ChatFileNotFound as FileNotFound } from "@sugabots/contracts/errors/chat-reads";
import {
	FileTooLarge,
	TooManyUnsentAttachments,
	UnsentAttachmentsNotFound,
} from "@sugabots/contracts/errors/chats";
import { userText } from "@sugabots/errors";
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
import { Config, Context, Data, Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { BlobStore } from "../blob-store/blob-store.ts";
import { type AttachedFileRow, loadFileParts } from "../chats/store/file-parts.ts";
import { afterCommit, query, serviceOperations, transaction } from "../database/database.ts";
import { file, message, WRITTEN_FILE_KINDS } from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";
import type { UserFacing } from "../user-message.ts";

/**
 * The files kept whole in a chat, which its bots read, and members too
 * when a chat serves them: every `file` but those bots write in
 * versions, which `files.ts` keeps. Their only writer, and their reader but
 * for the files messages show, which `store/file-parts.ts` reads. A file
 * goes when its chat does.
 *
 * A file is a tool's result, kept with `write`, a member's attachment, kept with
 * `upload`, or a bot's attachment to its reply, kept with `withReplyFile`. An
 * attachment stays unsent, and unreadable, until it is attached to a message; one
 * never attached is removed by `removeUnsentAttachments`.
 */
export interface Interface {
	/**
	 * Keeps `content` as a file in the chat. Fails with `FileTooLarge` when
	 * it is over `CHAT_FILE_MAX_BYTES` or what the blob store keeps, and with
	 * whatever `content.stream` fails with.
	 */
	readonly write: <E>(file: {
		chatId: string;
		/** The call whose result `content` is. */
		toolCallId: string;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<FileDescription, E | FileTooLarge | BlobStore.Failure>;
	/**
	 * Keeps `content` as a file `uploaderId` uploaded to the chat, unsent
	 * until it is attached to a message. Fails as `write` does, with
	 * `FileTooLarge` past `maxSize` bytes, and with `TooManyUnsentAttachments`,
	 * keeping nothing, when the uploader already has `maxUnsent` unsent
	 * attachments in the chat. Uploads at the same moment may each pass that
	 * check, so it bounds them only roughly.
	 */
	readonly upload: <E>(file: {
		chatId: string;
		uploaderId: string;
		name: string;
		maxSize: number;
		maxUnsent: number;
		content: BlobStore.Content<E>;
	}) => Effect.Effect<
		UnsentAttachment,
		E | FileTooLarge | TooManyUnsentAttachments | BlobStore.Failure
	>;
	/**
	 * The file. Fails with `FileNotFound` when no file in the chat has that
	 * id, including when `fileId` is not an id at all, and for an unsent
	 * attachment. The stream fails with `FileNotFound` if the chat is deleted
	 * while it is read.
	 */
	readonly read: (file: {
		chatId: string;
		fileId: string;
	}) => Effect.Effect<StoredFile, FileNotFound | BlobStore.Failure>;
	/**
	 * A file attached to a message in the chat, as `read` gives it. Fails
	 * with `FileNotFound` for any other file, such as a tool call's result.
	 */
	readonly readMessageFile: (file: {
		chatId: string;
		fileId: string;
	}) => Effect.Effect<StoredFile, FileNotFound | BlobStore.Failure>;
	/**
	 * Attaches the unsent attachments `fileIds` to `messageId` in the order listed, and
	 * returns them in that order. Each must be one of `uploaderId`'s unsent
	 * attachments in the chat; when any is not, including one removed for
	 * waiting too long, fails with `UnsentAttachmentsNotFound` and attaches none.
	 */
	readonly attach: (input: {
		chatId: string;
		messageId: string;
		uploaderId: string;
		fileIds: readonly string[];
	}) => Effect.Effect<readonly AttachedFileRow[], UnsentAttachmentsNotFound>;
	/** The files in the chat kept as tool calls' results: each call's file id, by the call's id. */
	readonly resultFiles: (chatId: string) => Effect.Effect<ReadonlyMap<string, string>>;
	/**
	 * Puts `content` in the blob store as a file for a bot's reply
	 * `messageId`, then runs `use` with it, for `use` to attach with
	 * `attachToReply`. The blob is written before `use` runs, so nothing `use`
	 * locks waits on it, and removed if `use` fails. Run outside a transaction:
	 * one that rolls back after `use` succeeds would leave the blob until the
	 * chat goes.
	 */
	readonly withReplyFile: <A, E, R>(
		file: {
			chatId: string;
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
		chatId: string;
		messageId: string;
	}) => Effect.Effect<void>;
	/**
	 * Removes `fileId` when it is one of `uploaderId`'s unsent attachments in the
	 * chat, such as one taken off a message before it was sent. Anything
	 * else, a file already gone included, is left as it is.
	 */
	readonly removeUnsentAttachment: (file: {
		chatId: string;
		uploaderId: string;
		fileId: string;
	}) => Effect.Effect<void>;
	/**
	 * Removes every attachment still unsent `unsentFor` after it was uploaded, and
	 * returns how many. A blob that cannot be removed is left to go with its
	 * chat's folder.
	 */
	readonly removeUnsentAttachments: (unsentFor: Duration.Duration) => Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()(
	"@sugabots/core/ChatFileStore",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("ChatFileStore");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const maxFileBytes = yield* Config.option(maxFileBytesConfig);

	/**
	 * Puts `content` in the blob store as a new file in the chat, with no row
	 * yet: a row is never without its blob.
	 */
	const putBlob = <E>(
		chatId: string,
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
			const { size } = yield* blobs.put(fileKey(chatId, id), { stream, contentType }).pipe(
				Effect.catchIf(
					(error) => error instanceof BlobStore.TooLarge,
					({ maxSize }) => new FileTooLarge({ maxSize }),
				),
			);
			return { id, contentType, size } satisfies FileDescription;
		});

	/** Keeps `content` as a new file in the chat, its row saying where it came from. */
	const keep = <E>(
		chatId: string,
		content: BlobStore.Content<E>,
		source: FileSource,
		maxSize = Number.POSITIVE_INFINITY,
	) =>
		Effect.gen(function* () {
			const kept = yield* putBlob(chatId, content, maxSize);
			yield* query((db) => db.insert(file).values({ ...kept, chatId, ...source })).pipe(
				Effect.onError(() => removeBlob(chatId, kept.id)),
			);
			return kept;
		});

	/** Removes a file's blob, once its row is gone or was never kept; one that cannot be removed goes with the chat's folder. */
	const removeBlob = (chatId: string, fileId: string) =>
		blobs
			.delete(fileKey(chatId, fileId))
			.pipe(
				Effect.catchCause((cause) =>
					Effect.logWarning("Removing a chat file's blob failed", cause),
				),
			);

	/** The file `fileId` in the chat, when its row also matches `which`. */
	const readWhere = (chatId: string, fileId: string, which: SQLWrapper) =>
		Effect.gen(function* () {
			// The id comes from the model or a URL, and Postgres rejects a uuid
			// comparison against anything that is not one.
			if (!isUuid(fileId)) return yield* new FileNotFound({ fileId });
			const [found] = yield* query((db) =>
				db
					.select({ id: file.id, name: file.name })
					.from(file)
					.where(and(eq(file.id, fileId), eq(file.chatId, chatId), keptInChat, which)),
			);
			if (!found) return yield* new FileNotFound({ fileId });
			// A row is never without its blob, as `keep` puts the blob first.
			const stored = yield* blobs
				.get(fileKey(chatId, found.id))
				.pipe(Effect.catchTag("BlobNotFound", Effect.die));
			const stream = stored.stream.pipe(
				Stream.catchTag("BlobNotFound", () => Stream.fail(new FileNotFound({ fileId }))),
			);
			return { id: found.id, name: found.name ?? undefined, ...stored, stream };
		});

	return Service.of({
		write: ({ chatId, toolCallId, content }) =>
			operation("write", keep(chatId, content, { kind: "tool_result", toolCallId })),
		upload: ({ chatId, uploaderId, name, maxSize, maxUnsent, content }) =>
			operation(
				"upload",
				Effect.gen(function* () {
					const [{ unsent } = { unsent: 0 }] = yield* query((db) =>
						db
							.select({ unsent: count() })
							.from(file)
							.where(
								and(eq(file.chatId, chatId), eq(file.uploaderId, uploaderId), unsentAttachment),
							),
					);
					if (unsent >= maxUnsent) return yield* new TooManyUnsentAttachments({ maxUnsent });
					const kept = yield* keep(
						chatId,
						content,
						{ kind: "attachment", uploaderId, name },
						maxSize,
					);
					return { ...kept, name };
				}),
			),
		read: ({ chatId, fileId }) =>
			operation("read", readWhere(chatId, fileId, sql`not ${unsentAttachment}`)),
		readMessageFile: ({ chatId, fileId }) =>
			operation("readMessageFile", readWhere(chatId, fileId, isNotNull(file.messageId))),
		attach: ({ chatId, messageId, uploaderId, fileIds }) =>
			operation(
				"attach",
				transaction(
					Effect.gen(function* () {
						const wanted = [...new Set(fileIds)];
						// The ids come from the client, and Postgres rejects a uuid
						// comparison against anything that is not one.
						if (!wanted.every(isUuid)) return yield* new UnsentAttachmentsNotFound();
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
										eq(file.chatId, chatId),
										eq(file.uploaderId, uploaderId),
										unsentAttachment,
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
						if (attached.length !== wanted.length) return yield* new UnsentAttachmentsNotFound();
						const listed = new Map(attached.map((one) => [one.id, one]));
						return wanted.flatMap((id) => listed.get(id) ?? []);
					}),
				),
			),
		resultFiles: (chatId) =>
			operation(
				"resultFiles",
				Effect.gen(function* () {
					const rows = yield* query((db) =>
						db
							.select({ id: file.id, toolCallId: file.toolCallId })
							.from(file)
							.where(and(eq(file.chatId, chatId), isNotNull(file.toolCallId))),
					);
					return new Map(
						rows.flatMap(({ id, toolCallId }) => (toolCallId ? [[toolCallId, id]] : [])),
					);
				}),
			),
		withReplyFile: ({ chatId, messageId, name, contentType, content }, use) =>
			operation(
				"withReplyFile",
				Effect.gen(function* () {
					const kept = yield* putBlob(chatId, {
						stream: Stream.succeed(content),
						contentType,
					});
					const stored = { ...kept, chatId, messageId, name } as StoredReplyFile;
					return yield* use(stored).pipe(Effect.onError(() => removeBlob(chatId, kept.id)));
				}),
			),
		attachToReply: (stored) =>
			operation(
				"attachToReply",
				transaction(
					Effect.gen(function* () {
						const { id, chatId, messageId, name, contentType, size } = stored;
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
								chatId,
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
		removeReplyAttachments: ({ chatId, messageId }) =>
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
						Effect.forEach(removed, ({ id }) => removeBlob(chatId, id), { discard: true }),
					);
				}),
			),
		removeUnsentAttachment: ({ chatId, uploaderId, fileId }) =>
			operation(
				"removeUnsentAttachment",
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
									eq(file.chatId, chatId),
									eq(file.uploaderId, uploaderId),
									unsentAttachment,
								),
							)
							.returning({ id: file.id }),
					);
					if (removed.length > 0) yield* removeBlob(chatId, fileId);
				}),
			),
		removeUnsentAttachments: (unsentFor) =>
			operation(
				"removeUnsentAttachments",
				Effect.gen(function* () {
					// Measured on the database's clock, which stamped `created_at`.
					const removed = yield* query((db) =>
						db
							.delete(file)
							.where(
								and(
									unsentAttachment,
									lt(
										file.createdAt,
										sql`now() - make_interval(secs => ${Duration.toSeconds(unsentFor)})`,
									),
								),
							)
							.returning({ id: file.id, chatId: file.chatId }),
					);
					yield* Effect.forEach(removed, ({ id, chatId }) => removeBlob(chatId, id), {
						discard: true,
					});
					return removed.length;
				}),
			),
	});
});

export const layer = Layer.effect(Service, make);

/**
 * The largest file kept, from `CHAT_FILE_MAX_BYTES`, below what the blob
 * store keeps. Unset, the blob store's limit is the only one.
 */
const maxFileBytesConfig = Config.schema(
	Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
	"CHAT_FILE_MAX_BYTES",
);

interface FileDescription {
	id: string;
	contentType: string;
	/** In bytes. */
	size: number;
}

/** A file being read: its description, its name when it is an attachment, and its bytes. */
export interface StoredFile extends FileDescription {
	/** An attachment's name; a tool result has none. */
	name: string | undefined;
	stream: Stream.Stream<Uint8Array, FileNotFound | BlobStore.Failure>;
}

declare const storedReplyFile: unique symbol;

/**
 * A file for a bot's reply whose blob `withReplyFile` has written, for
 * `attachToReply` to attach. Only `withReplyFile` makes one.
 */
interface StoredReplyFile extends FileDescription {
	readonly [storedReplyFile]: true;
	readonly chatId: string;
	readonly messageId: string;
	readonly name: string;
}

/** A file a member uploaded and has not sent yet, with the name it had on their computer. */
export interface UnsentAttachment extends FileDescription {
	name: string;
}

/**
 * A file kept here, as one blob in the chat's folder: not a file a
 * bot wrote, whose versions `files.ts` keeps.
 */
const keptInChat = notInArray(file.kind, [...WRITTEN_FILE_KINDS]);

/** An attachment whose message is not sent yet, which only its uploader knows of. */
const unsentAttachment = sql`(${file.kind} = 'attachment' and ${file.messageId} is null)`;

/** Which kind of file a row is, with the columns that kind sets. */
type FileSource =
	| { kind: "tool_result"; toolCallId: string }
	| { kind: "attachment"; uploaderId: string; name: string }
	| { kind: "bot_attachment"; name: string; messageId: string; position: number };

export class TooManyReplyFiles extends Data.TaggedError("TooManyReplyFiles") implements UserFacing {
	get userMessage() {
		return userText`A reply can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files`;
	}
}

/**
 * Under the chat's folder, `chats/<chatId>`, which the
 * `chat_blob_deletion` trigger queues for deletion with the chat.
 */
function fileKey(chatId: string, fileId: string): BlobStore.Key {
	return BlobStore.key("chats", chatId, "files", fileId);
}
