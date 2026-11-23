export * as Files from "./files.ts";

import {
	type FileAuthor,
	type FileSummary,
	type FileVersionSummary,
	MAX_FILE_CONTENT_CHARACTERS,
	type MessageFileSummary,
	type WrittenFile,
	type WrittenFileKind,
	type WrittenFileSummary,
} from "@sugabots/contracts";
import { and, desc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, Data, Effect, Layer, Stream } from "effect";
import {
	ActionForbidden,
	type AuthorizationDenied,
	ResourceHidden,
} from "../authorization/access.ts";
import { Authorization } from "../authorization/authorization.ts";
import type { CurrentActor } from "../authorization/current-actor.ts";
import { Visibility } from "../authorization/visibility.ts";
import { BlobStore } from "../blob-store/blob-store.ts";
import { query, serviceOperations, transaction, writtenRow } from "../database/database.ts";
import {
	type BotRow,
	blobDeletion,
	bot,
	type FileRow,
	type FileVersionRow,
	file,
	fileVersion,
	message,
	person,
	placedChat,
	WRITTEN_FILE_KINDS,
} from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";

/**
 * Reading files, for people. A file is reached through the chat it
 * was uploaded or made in: a project's by the people in the project, a bot's
 * by whoever reaches the bot. One made in a collaboration or an automation's
 * run belongs to the chat that was opened from. Only a file a bot
 * wrote is read here, with its versions; a file on a message is read through
 * its chat (see `chats/chats/chat-files.ts`). Deleting a
 * written file takes changing the project or the bot.
 */
export interface Interface {
	/**
	 * The files uploaded or made in the project's chats, and what was
	 * opened from them, newest change first.
	 */
	readonly listInProject: (input: {
		projectId: string;
	}) => Effect.Effect<FileSummary[], AuthorizationDenied, CurrentActor.Service>;
	/** The written file at its current version. */
	readonly get: (
		at: InFile,
	) => Effect.Effect<WrittenFile, AuthorizationDenied, CurrentActor.Service>;
	/** What the written file is, without reading its content. */
	readonly summary: (
		at: InFile,
	) => Effect.Effect<WrittenFileSummary, AuthorizationDenied, CurrentActor.Service>;
	/** Its versions, newest first. */
	readonly versions: (
		at: InFile,
	) => Effect.Effect<FileVersionSummary[], AuthorizationDenied, CurrentActor.Service>;
	readonly getVersion: (
		at: InFile & { version: number },
	) => Effect.Effect<WrittenFile, AuthorizationDenied, CurrentActor.Service>;
	/** Deletes the written file with every version of it; its stored content is removed after. */
	readonly remove: (at: InFile) => Effect.Effect<void, AuthorizationDenied, CurrentActor.Service>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Files") {}

/**
 * Making and changing written files, for a bot's tools. A bot reaches the
 * files written in the chat it is working in, and what was opened
 * from it; in a project's chat, every file written in the project;
 * and in its own chat or automation feed, every file written in its own chats
 * and feeds, which whoever reaches the bot sees. Never the files it wrote
 * elsewhere, which the people of the chat it is working in may not
 * see. Every change names the version it was based on and is refused with
 * `Stale` if another landed first, so one writer never silently overwrites
 * another.
 */
export interface AuthoringInterface {
	readonly list: (by: BotInChat) => Effect.Effect<WrittenFileSummary[]>;
	readonly read: (by: BotInChat, fileId: string) => Effect.Effect<WrittenFile, NotFound>;
	readonly create: (
		by: BotInChat,
		input: { kind: WrittenFileKind; title: string; content: string },
	) => Effect.Effect<WrittenFile, TooLarge>;
	readonly replace: (
		by: BotInChat,
		input: {
			fileId: string;
			baseVersion: number;
			content: string;
			title?: string;
			/** Write over `baseVersion` instead of after it, as when the same reply wrote it. */
			inPlace?: boolean;
			/** What the writer takes the file to be; refused with `KindFixed` if it is another kind. */
			kind?: WrittenFileKind;
		},
	) => Effect.Effect<WrittenFile, NotFound | Stale | KindFixed | TooLarge>;
	/**
	 * Replaces the one place `oldText` appears in the current content with
	 * `newText`, as a new version, so a small change needn't resend the rest.
	 */
	readonly edit: (
		by: BotInChat,
		input: {
			fileId: string;
			baseVersion: number;
			oldText: string;
			newText: string;
			/** Write over `baseVersion` instead of after it, as when the same reply wrote it. */
			inPlace?: boolean;
		},
	) => Effect.Effect<WrittenFile, NotFound | Stale | EditTextUnmatched | TooLarge>;
}

export class Authoring extends Context.Service<Authoring, AuthoringInterface>()(
	"@sugabots/core/Files/Authoring",
) {}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Files");
	const authorization = yield* Authorization.Service;
	const visibility = yield* Visibility.Service;
	const blobs = yield* BlobStore.Service;
	const atVersion = atVersionIn(blobs);

	/** The written file, once the actor reaches the chat it was made in, with their standing there. */
	const inReachedChat = (fileId: string) =>
		Effect.gen(function* () {
			const found = yield* writtenFileWithId(fileId);
			if (!found) return yield* new ResourceHidden({ resource: "file" });
			const standing = yield* visibility
				.chatStanding(found.file.chatId)
				.pipe(Effect.mapError(() => new ResourceHidden({ resource: "file" })));
			return { found, standing };
		});

	return Service.of({
		listInProject: ({ projectId }) =>
			operation(
				"listInProject",
				Effect.flatMap(authorization.project(projectId, "project.read"), () =>
					listedWhere(eq(madeInChat.projectId, projectId)),
				),
			),

		get: ({ fileId }) =>
			operation(
				"get",
				Effect.gen(function* () {
					const { found } = yield* inReachedChat(fileId);
					return yield* shownOrHidden(atVersion(found, found.file.currentVersion));
				}),
			),

		summary: ({ fileId }) =>
			operation(
				"summary",
				Effect.map(inReachedChat(fileId), ({ found }) => toSummary(found.file, found.creator)),
			),

		versions: ({ fileId }) =>
			operation(
				"versions",
				Effect.flatMap(inReachedChat(fileId), ({ found }) => versionsOf(found.file.id)),
			),

		getVersion: ({ fileId, version }) =>
			operation(
				"getVersion",
				Effect.gen(function* () {
					const { found } = yield* inReachedChat(fileId);
					return yield* shownOrHidden(atVersion(found, version));
				}),
			),

		remove: ({ fileId }) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const { found, standing } = yield* inReachedChat(fileId);
					if (!standing.standing.may("project.chats.manage")) {
						return yield* new ActionForbidden({ permission: "project.chats.manage" });
					}
					// The versions go with it, and the `file_blob_deletion` trigger queues its blobs.
					yield* query((db) => db.delete(file).where(eq(file.id, found.file.id)));
				}),
			),
	});
});

const makeAuthoring = Effect.gen(function* () {
	const operation = yield* serviceOperations<AuthoringInterface>("Files.Authoring");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const atVersion = atVersionIn(blobs);

	/**
	 * Puts `content` in the blob store as a new version of `fileId`, then
	 * runs `record` to write its rows. The blob goes first so a row is never
	 * without its blob; if `record` fails, the blob is removed, and if that
	 * fails too, it goes with the file's folder.
	 */
	const withContent = <A, E, R>(
		fileId: string,
		kind: WrittenFileKind,
		content: string,
		record: (stored: StoredContent) => Effect.Effect<A, E, R>,
	) =>
		Effect.gen(function* () {
			if (content.length > MAX_FILE_CONTENT_CHARACTERS) {
				return yield* new TooLarge({ maxCharacters: MAX_FILE_CONTENT_CHARACTERS });
			}
			const versionId = yield* ids.next;
			const key = versionKey(fileId, versionId);
			const contentType = CONTENT_TYPES[kind];
			// Content under the limit above is far under any store's, so its `TooLarge`
			// can't happen. A store that can't be reached is an infrastructure fault:
			// the bot's tool reports that its call failed.
			const { size } = yield* blobs
				.put(key, { stream: Stream.succeed(new TextEncoder().encode(content)), contentType })
				.pipe(Effect.orDie);
			return yield* record({ versionId, contentType, size }).pipe(
				Effect.onError(() => blobs.delete(key).pipe(Effect.ignore)),
			);
		});

	const requireFile = (by: BotInChat, fileId: string, { lock = true } = {}) =>
		fileReachedBy(by, fileId, { lock }).pipe(
			Effect.filterOrFail(
				(found) => found !== undefined,
				() => new NotFound({ fileId }),
			),
		);

	/**
	 * Writes `content` as the version after `baseVersion`, or `inPlace` of it,
	 * if that is still the current one. A version written over keeps its
	 * number; its old content's blob is queued for deletion.
	 */
	const writeVersion = (
		by: BotInChat,
		found: FoundFile,
		baseVersion: number,
		changes: { stored: StoredContent; title?: string; inPlace?: boolean },
	) =>
		Effect.gen(function* () {
			const current = found.file.currentVersion;
			if (baseVersion !== current) {
				return yield* new Stale({ currentVersion: current });
			}
			if (changes.inPlace) yield* removeVersion(found.file.id, current);
			const number = changes.inPlace ? current : current + 1;
			const updated = yield* query((db) =>
				db
					.update(file)
					.set({ currentVersion: number, ...(changes.title ? { name: changes.title } : {}) })
					.where(eq(file.id, found.file.id))
					.returning(),
			).pipe(Effect.flatMap(writtenRow("file")));
			const version = yield* insertVersion(found.file, number, changes.stored, by.botId);
			return toWrittenFile(
				{ file: asWritten(updated), creator: found.creator },
				version,
				yield* botNamed(by.botId),
				"",
			);
		});

	return Authoring.of({
		list: (by) =>
			operation(
				"list",
				Effect.flatMap(chatOf(by.chatId), (working) =>
					writtenSummariesWhere(reachedByBot(working)),
				),
			),

		read: (by, fileId) =>
			operation(
				"read",
				Effect.gen(function* () {
					const found = yield* fileReachedBy(by, fileId);
					const shown = found && (yield* atVersion(found, found.file.currentVersion));
					if (!shown) return yield* new NotFound({ fileId });
					return shown;
				}),
			),

		create: (by, input) =>
			operation(
				"create",
				Effect.flatMap(ids.next, (fileId) =>
					withContent(fileId, input.kind, input.content, (stored) =>
						transaction(
							Effect.gen(function* () {
								const row = yield* query((db) =>
									db
										.insert(file)
										.values({
											id: fileId,
											chatId: by.chatId,
											kind: input.kind,
											name: input.title,
											currentVersion: 1,
											createdByBotId: by.botId,
										})
										.returning(),
								).pipe(Effect.flatMap(writtenRow("file")));
								const written = asWritten(row);
								const version = yield* insertVersion(written, 1, stored, by.botId);
								const author = yield* botNamed(by.botId);
								return toWrittenFile(
									{ file: written, creator: author },
									version,
									author,
									input.content,
								);
							}),
						),
					),
				),
			),

		replace: (by, { fileId, baseVersion, content, title, inPlace, kind }) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const before = yield* requireFile(by, fileId, { lock: false });
					if (kind && kind !== before.file.kind) {
						return yield* new KindFixed({ kind: before.file.kind });
					}
					const written = yield* withContent(before.file.id, before.file.kind, content, (stored) =>
						transaction(
							Effect.flatMap(requireFile(by, fileId), (found) =>
								writeVersion(by, found, baseVersion, {
									stored,
									inPlace,
									...(title ? { title } : {}),
								}),
							),
						),
					);
					return { ...written, content };
				}),
			),

		edit: (by, { fileId, baseVersion, oldText, newText, inPlace }) =>
			operation(
				"edit",
				// The edit is made to the content as it is under the file's lock: an
				// edit written in place keeps the version's number, so two edits to it
				// would both pass the version check, and one made to content read
				// before the lock would undo the other.
				transaction(
					Effect.gen(function* () {
						const found = yield* requireFile(by, fileId);
						if (baseVersion !== found.file.currentVersion) {
							return yield* new Stale({ currentVersion: found.file.currentVersion });
						}
						const current = (yield* atVersion(found, found.file.currentVersion))?.content ?? "";
						const matches = current.split(oldText).length - 1;
						if (oldText === "" || matches !== 1) return yield* new EditTextUnmatched({ matches });
						// A function, so `$` in the new text is never read as a replacement pattern.
						const edited = current.replace(oldText, () => newText);
						const written = yield* withContent(found.file.id, found.file.kind, edited, (stored) =>
							writeVersion(by, found, baseVersion, { stored, inPlace }),
						);
						return { ...written, content: edited };
					}),
				),
			),
	});
});

export const layerNoDeps = Layer.effect(Service, make);

export const layer = layerNoDeps.pipe(Layer.provide([Authorization.layer, Visibility.layer]));

export const authoringLayer = Layer.effect(Authoring, makeAuthoring);

/**
 * Version `version` of a written file, read without asking who wants it:
 * only for a caller that has already authorized the read, as a sealed page
 * address has (see `pages.ts`). `undefined` when there is no such file or
 * version.
 */
export const readVersionUnchecked =
	(blobs: BlobStore.Interface) => (fileId: string, version: number) =>
		Effect.gen(function* () {
			const found = yield* writtenFileWithId(fileId);
			if (!found) return undefined;
			return yield* atVersionIn(blobs)(found, version);
		});

/** A version's content as kept in the blob store. */
interface StoredContent {
	versionId: string;
	contentType: string;
	/** In bytes. */
	size: number;
}

const CONTENT_TYPES: Record<WrittenFileKind, string> = {
	document: "text/markdown; charset=utf-8",
	html: "text/html; charset=utf-8",
};

/** Under the file's folder, `files/<fileId>`, which the `file_blob_deletion` trigger queues for deletion with the file. */
function versionKey(fileId: string, versionId: string): BlobStore.Key {
	return BlobStore.key("files", fileId, "versions", versionId);
}

export interface InFile {
	fileId: string;
}

/** The bot a tool acts for, in the chat it is working in, which a new file records it was made in. */
export interface BotInChat {
	botId: string;
	chatId: string;
}

export class NotFound extends Data.TaggedError("FileNotFound")<{
	readonly fileId: string;
}> {}

/** Another version landed after the one a change was based on. */
export class Stale extends Data.TaggedError("FileStale")<{
	readonly currentVersion: number;
}> {}

/** A write took the file for another kind than the one it is, which never changes. */
export class KindFixed extends Data.TaggedError("FileKindFixed")<{
	readonly kind: WrittenFileKind;
}> {}

/** Content would be over `maxCharacters`, the most a written file holds. */
export class TooLarge extends Data.TaggedError("FileContentTooLarge")<{
	readonly maxCharacters: number;
}> {}

/** An edit's text appears in the file `matches` times, not exactly once. */
export class EditTextUnmatched extends Data.TaggedError("EditTextUnmatched")<{
	readonly matches: number;
}> {}

/** A `file` row of a written kind, with the columns that kind sets. */
type WrittenFileRow = FileRow & { kind: WrittenFileKind; name: string; currentVersion: number };

/** `row`, read from where only written files are, as one; the `file_source_valid` check keeps it so. */
function asWritten(row: FileRow): WrittenFileRow {
	if (!isWrittenKind(row.kind) || row.name === null || row.currentVersion === null) {
		throw new Error(`File ${row.id} is not a written file`);
	}
	return row as WrittenFileRow;
}

function isWrittenKind(kind: FileRow["kind"]): kind is WrittenFileKind {
	return (WRITTEN_FILE_KINDS as readonly string[]).includes(kind);
}

const isWritten = inArray(file.kind, [...WRITTEN_FILE_KINDS]);

interface FoundFile {
	file: WrittenFileRow;
	creator: FileAuthor;
}

const authorOf = (row: Pick<BotRow, "id" | "name"> | null): FileAuthor =>
	row ? { botId: row.id, name: row.name } : null;

/** The written file `fileId` where `scope` holds of it and the chat it was made in. */
const writtenFileWhere = (
	fileId: string,
	scope: SQL | undefined,
	options: { lock?: boolean } = {},
) =>
	Effect.gen(function* () {
		if (!isUuid(fileId)) return undefined;
		const [row] = yield* query((db) => {
			const select = db
				.select({ file, creator: { id: bot.id, name: bot.name } })
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.innerJoin(madeInChat, chatOfMadeIn)
				.leftJoin(bot, eq(bot.id, file.createdByBotId))
				.where(and(eq(file.id, fileId), isWritten, scope))
				.limit(1);
			return options.lock ? select.for("update", { of: file }) : select;
		});
		return row ? { file: asWritten(row.file), creator: authorOf(row.creator) } : undefined;
	});

const writtenFileWithId = (fileId: string) => writtenFileWhere(fileId, undefined);

/**
 * The chat a file was made in, joined beside `placedChat`,
 * the chat it was made in: that chat itself, or for a
 * collaboration or an automation's run, the one it was opened from.
 */
const madeInChat = alias(placedChat, "made_in_chat");
const chatOfMadeIn = eq(madeInChat.id, sql`coalesce(${placedChat.rootChatId}, ${placedChat.id})`);

/** The chat a bot is working in, by the chat its turn is in. */
interface WorkingChat {
	id: string;
	projectId: string | null;
}

/**
 * The files a bot working in `working` reaches: see `AuthoringInterface`. In
 * the bot's own chats and automation feeds, its default project's files.
 */
const reachedByBot = (working: WorkingChat | undefined): SQL => {
	if (!working) return sql`false`;
	return (
		or(
			eq(madeInChat.id, working.id),
			working.projectId === null ? undefined : eq(madeInChat.projectId, working.projectId),
		) ?? sql`false`
	);
};

/** The chat `chatId` is in: itself, or the one it was opened from. */
const chatOf = (chatId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ id: madeInChat.id, projectId: madeInChat.projectId })
				.from(placedChat)
				.innerJoin(madeInChat, chatOfMadeIn)
				.where(eq(placedChat.id, chatId))
				.limit(1),
		),
		([row]): WorkingChat | undefined => row,
	);

const fileReachedBy = (by: BotInChat, fileId: string, options: { lock?: boolean } = {}) =>
	Effect.flatMap(chatOf(by.chatId), (working) =>
		writtenFileWhere(fileId, reachedByBot(working), options),
	);

const writtenSummariesWhere = (scope: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({ file, creator: { id: bot.id, name: bot.name } })
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.innerJoin(madeInChat, chatOfMadeIn)
				.leftJoin(bot, eq(bot.id, file.createdByBotId))
				.where(and(isWritten, scope))
				.orderBy(desc(file.updatedAt)),
		),
		(rows) => rows.map((row) => toSummary(asWritten(row.file), authorOf(row.creator))),
	);

/**
 * A file on a message that people can open from a list: a sent upload or a
 * bot's attachment, in a chat itself rather than in a collaboration
 * or a run opened from one, as only a chat's files are served.
 */
const isListedMessageFile = and(
	inArray(file.kind, ["upload", "bot_attachment"]),
	isNotNull(file.messageId),
	eq(file.chatId, madeInChat.id),
);

/** The files people see listed where `scope` holds: those bots wrote, and those on messages, newest change first. */
const listedWhere = (scope: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({
					file,
					creator: { id: bot.id, name: bot.name },
					uploader: person.name,
				})
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.innerJoin(madeInChat, chatOfMadeIn)
				.leftJoin(message, eq(message.id, file.messageId))
				// The bot that wrote it, or that attached it to its reply.
				.leftJoin(bot, eq(bot.id, sql`coalesce(${file.createdByBotId}, ${message.authorBotId})`))
				.leftJoin(person, eq(person.id, file.uploaderId))
				.where(and(or(isWritten, isListedMessageFile), scope))
				.orderBy(desc(file.updatedAt)),
		),
		(rows) =>
			rows.map(
				({ file: row, creator, uploader }): FileSummary =>
					isWrittenKind(row.kind)
						? toSummary(asWritten(row), authorOf(creator))
						: toMessageFileSummary(row, row.kind === "upload" ? uploader : (creator?.name ?? null)),
			),
	);

const toMessageFileSummary = (row: FileRow, sentBy: string | null): MessageFileSummary => ({
	id: row.id,
	chatId: row.chatId,
	kind: row.kind === "upload" ? "upload" : "attachment",
	// A file on a message always has a name, type and size, by `file_source_valid`.
	name: row.name ?? "",
	contentType: row.contentType ?? "",
	size: row.size ?? 0,
	sentBy,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const versionsOf = (fileId: string) =>
	Effect.map(
		query((db) =>
			db
				.select({ version: fileVersion, author: { id: bot.id, name: bot.name } })
				.from(fileVersion)
				.leftJoin(bot, eq(bot.id, fileVersion.authorBotId))
				.where(eq(fileVersion.fileId, fileId))
				.orderBy(desc(fileVersion.number)),
		),
		(rows) => rows.map((row) => toVersionSummary(row.version, authorOf(row.author))),
	);

const versionRow = (fileId: string, number: number) =>
	Effect.map(
		query((db) =>
			db
				.select({ version: fileVersion, author: { id: bot.id, name: bot.name } })
				.from(fileVersion)
				.leftJoin(bot, eq(bot.id, fileVersion.authorBotId))
				.where(and(eq(fileVersion.fileId, fileId), eq(fileVersion.number, number)))
				.limit(1),
		),
		([row]) => row && { ...row.version, author: authorOf(row.author) },
	);

/** The file as of version `number`, or `undefined` when it has no such version. */
const atVersionIn = (blobs: BlobStore.Interface) => (found: FoundFile, number: number) =>
	Effect.gen(function* () {
		const version = yield* versionRow(found.file.id, number);
		if (!version) return undefined;
		// A row is never without its blob, as a write puts the blob first. A store
		// that can't be reached is an infrastructure fault, which a person's
		// request answers as a server error and a bot's tool as a failed call.
		const stored = yield* blobs.get(versionKey(found.file.id, version.id)).pipe(Effect.orDie);
		const content = yield* Stream.mkString(Stream.decodeText(stored.stream)).pipe(Effect.orDie);
		return toWrittenFile(found, version, version.author, content);
	});

const shownOrHidden = <E, R>(shown: Effect.Effect<WrittenFile | undefined, E, R>) =>
	shown.pipe(
		Effect.filterOrFail(
			(written) => written !== undefined,
			() => new ResourceHidden({ resource: "file" }),
		),
	);

const insertVersion = (
	of: WrittenFileRow,
	number: number,
	{ versionId, contentType, size }: StoredContent,
	botId: string,
) =>
	query((db) =>
		db
			.insert(fileVersion)
			.values({
				id: versionId,
				fileId: of.id,
				fileKind: of.kind,
				number,
				contentType,
				size,
				authorBotId: botId,
			})
			.returning(),
	).pipe(Effect.flatMap(writtenRow("file_version")));

/** Deletes version `number` of the file, queueing its content's blob for deletion. */
const removeVersion = (fileId: string, number: number) =>
	Effect.gen(function* () {
		const removed = yield* query((db) =>
			db
				.delete(fileVersion)
				.where(and(eq(fileVersion.fileId, fileId), eq(fileVersion.number, number)))
				.returning({ id: fileVersion.id }),
		);
		if (removed.length === 0) return;
		yield* query((db) =>
			db.insert(blobDeletion).values(removed.map(({ id }) => ({ prefix: versionKey(fileId, id) }))),
		);
	});

const botNamed = (botId: string) =>
	Effect.map(
		query((db) => db.select({ id: bot.id, name: bot.name }).from(bot).where(eq(bot.id, botId))),
		([row]) => authorOf(row ?? null),
	);

const toSummary = (row: WrittenFileRow, creator: FileAuthor): WrittenFileSummary => ({
	id: row.id,
	chatId: row.chatId,
	kind: row.kind,
	title: row.name,
	version: row.currentVersion,
	createdBy: creator,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const toVersionSummary = (row: FileVersionRow, author: FileAuthor): FileVersionSummary => ({
	number: row.number,
	author,
	createdAt: row.createdAt.toISOString(),
});

const toWrittenFile = (
	found: FoundFile,
	version: FileVersionRow,
	author: FileAuthor,
	content: string,
): WrittenFile => ({
	...toSummary(found.file, found.creator),
	content,
	shownVersion: toVersionSummary(version, author),
});
