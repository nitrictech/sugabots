export * as Files from "./files.ts";

import {
	type FileAuthor,
	type FileWritten,
	type ListedFile,
	type ListedFileVersion,
	type ListedMessageFile,
	type ListedWrittenFile,
	MAX_FILE_CONTENT_CHARACTERS,
	type WrittenFile,
	type WrittenFileKind,
} from "@sugabots/contracts";
import {
	FileContentTooLarge,
	FileEditTextUnmatched,
	FileKindFixed,
	FileStale,
} from "@sugabots/contracts/errors/files";
import {
	ActionForbidden,
	ApprovalRefused,
	ResourceHidden,
} from "@sugabots/contracts/errors/proofs";
import { and, desc, eq, inArray, isNotNull, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { Context, DateTime, Duration, Effect, Layer, Stream } from "effect";
import { BlobStore } from "../blob-store/blob-store.ts";
import {
	commitWrittenFile,
	executionFence,
	type FenceRefusal,
	replayWrittenFile,
} from "../chats/turns/turns.ts";
import {
	type Database,
	type Executor,
	query,
	serviceOperations,
	transaction,
	writtenRow,
} from "../database/database.ts";
import {
	automationRun,
	type BotRow,
	blobDeletion,
	bot,
	type FileRow,
	type FileVersionRow,
	file,
	fileVersion,
	member,
	message,
	placedChat,
	WRITTEN_FILE_KINDS,
} from "../database/schema.ts";
import { Ids, isUuid } from "../ids/ids.ts";
import type { BotPrincipal } from "../principal.ts";
import type { Approved } from "../proofs/approved.ts";
import type { CanChangeFile } from "../proofs/can-change-file.ts";
import type { CanManageChats } from "../proofs/chat-permissions.ts";
import type { CanChangeChat } from "../proofs/project-permissions.ts";
import type { ReachesChat } from "../proofs/reaches-chat.ts";
import type { ReachesFile } from "../proofs/reaches-file.ts";
import type { ReachesPage } from "../proofs/reaches-page.ts";
import type { ReachesProject } from "../proofs/reaches-project.ts";
import { processLayer, Tier } from "../tiers.ts";

/**
 * Reading files, for operations that have proved their principal reaches
 * them. A file is reached through the chat it was uploaded or made in: a
 * project's by the members in the project, a bot's by whoever reaches the
 * bot. One made in an automation's run belongs to the automation's feed,
 * which lists the run. Only a file a bot wrote is read here, with its
 * versions; a file on a message is read through its chat (see
 * `chats/chats/chat-files.ts`). Deleting a written file takes managing the
 * chats of its project.
 */
export interface Interface {
	/**
	 * The files uploaded or made in the chats of the project `reach` is
	 * about, and what was opened from them, newest change first.
	 */
	readonly listInProject: <P, J>(reach: ReachesProject<P, J>) => Effect.Effect<ListedFile[]>;
	/** The written file `reach` is about, at its current version. */
	readonly get: <P, F>(reach: ReachesFile<P, F>) => Effect.Effect<WrittenFile, ResourceHidden>;
	/** What the written file is, without reading its content. */
	readonly summary: <P, F>(
		reach: ReachesFile<P, F>,
	) => Effect.Effect<ListedWrittenFile, ResourceHidden>;
	/** Its versions, newest first. */
	readonly versions: <P, F>(
		reach: ReachesFile<P, F>,
	) => Effect.Effect<ListedFileVersion[], ResourceHidden>;
	readonly getVersion: <P, F>(
		reach: ReachesFile<P, F>,
		version: number,
	) => Effect.Effect<WrittenFile, ResourceHidden>;
	readonly servePage: <P, F>(
		reach: ReachesPage<P, F>,
	) => Effect.Effect<{ title: string; html: string }, ResourceHidden>;
	/** Deletes the written file with every version of it; its stored content is removed after. */
	readonly remove: <P, F>(
		reach: ReachesFile<P, F>,
		canManage: CanManageChats<P, F>,
	) => Effect.Effect<void, ResourceHidden>;
	readonly listWritten: <P, C, X>(
		reach: ReachesChat<P, C>,
		approved: Approved<P, X, [C], "files.listWritten">,
	) => Effect.Effect<ListedWrittenFile[]>;
	readonly readWritten: <P, F, X>(
		reach: ReachesFile<P, F>,
		approved: Approved<P, X, [F], "files.readWritten">,
	) => Effect.Effect<WrittenFile, ResourceHidden>;
	readonly create: <P, C, X>(
		canChange: CanChangeChat<P, C>,
		approved: Approved<P, X, [C], "files.write">,
		input: NewWrittenFile,
	) => Effect.Effect<
		FileWritten,
		ActionForbidden | ApprovalRefused | FileContentTooLarge | FenceRefusal
	>;
	readonly replace: <P, F, X>(
		canChange: CanChangeFile<P, F>,
		approved: Approved<P, X, [F], "files.write">,
		input: ReplaceWrittenFile,
	) => Effect.Effect<
		FileWritten,
		| ActionForbidden
		| ApprovalRefused
		| ResourceHidden
		| FileStale
		| FileKindFixed
		| FileContentTooLarge
		| FenceRefusal
	>;
	readonly edit: <P, F, X>(
		canChange: CanChangeFile<P, F>,
		approved: Approved<P, X, [F], "files.edit">,
		input: EditWrittenFile,
	) => Effect.Effect<
		FileWritten,
		| ActionForbidden
		| ApprovalRefused
		| ResourceHidden
		| FileStale
		| FileEditTextUnmatched
		| FileContentTooLarge
		| FenceRefusal
	>;
}

export class Service extends Context.Service<Service, Interface>()("@sugabots/core/Files") {
	declare readonly [Tier]: "process";
}

export const make = Effect.gen(function* () {
	const operation = yield* serviceOperations<Interface>("Files");
	const blobs = yield* BlobStore.Service;
	const ids = yield* Ids.Service;
	const atVersion = atVersionIn(blobs);

	/** The written file `reach` is about, in the chat it was found in; hidden when it isn't one a bot wrote. */
	const writtenFileIn = <P, F>(reach: ReachesFile<P, F>) =>
		requireWrittenFile(reach.file.value, reach.chat);

	const atCurrentVersion = <P, F>(reach: ReachesFile<P, F>) =>
		Effect.flatMap(writtenFileIn(reach), (found) =>
			shownOrHidden(atVersion(found, found.file.currentVersion)),
		);

	const appendVersion = (
		before: WrittenFileRow,
		writer: FileWriter,
		change: { baseVersion: number; content: string; title?: string },
	) =>
		withContent(blobs, ids, before.id, before.kind, change.content, (stored) =>
			recordFileWrite(
				writer,
				Effect.gen(function* () {
					const found = yield* requireWrittenFile(before.id, before.chatId, true);
					const number = yield* nextVersion(found, change.baseVersion);
					yield* query((db) =>
						db
							.update(file)
							.set({
								currentVersion: number,
								...(change.title !== undefined && { name: change.title }),
							})
							.where(eq(file.id, found.file.id)),
					);
					yield* insertVersion(found.file, number, stored, writer.principal.bot);
					return {
						status: "written" as const,
						fileId: found.file.id,
						kind: found.file.kind,
						title: change.title ?? found.file.name,
						version: number,
					};
				}),
			),
		);

	return Service.of({
		listInProject: (reach) =>
			operation("listInProject", listedWhere(eq(listingChat.projectId, reach.project.value))),

		get: (reach) => operation("get", atCurrentVersion(reach)),

		summary: (reach) =>
			operation(
				"summary",
				Effect.map(writtenFileIn(reach), (found) => toListedWrittenFile(found.file, found.creator)),
			),

		versions: (reach) =>
			operation(
				"versions",
				Effect.flatMap(writtenFileIn(reach), (found) => versionsOf(found.file.id)),
			),

		getVersion: (reach, version) =>
			operation(
				"getVersion",
				Effect.gen(function* () {
					const found = yield* writtenFileIn(reach);
					return yield* shownOrHidden(atVersion(found, version));
				}),
			),

		servePage: (reach) =>
			operation(
				"servePage",
				Effect.gen(function* () {
					const found = yield* requireWrittenFile(reach.file.value, reach.chat);
					const shown = yield* shownOrHidden(atVersion(found, reach.version));
					return { title: shown.title, html: shown.content };
				}),
			),

		remove: (reach, _canManage) =>
			operation(
				"remove",
				Effect.gen(function* () {
					const found = yield* writtenFileIn(reach);
					// The versions go with it, and the `file_blob_deletion` trigger queues its blobs.
					yield* query((db) => db.delete(file).where(eq(file.id, found.file.id)));
				}),
			),

		listWritten: (reach, _approved) =>
			operation(
				"listWritten",
				listedWrittenFilesWhere(eq(listingChat.projectId, reach.project.id)),
			),

		readWritten: (reach, _approved) => operation("readWritten", atCurrentVersion(reach)),

		create: (canChange, approved, input) =>
			operation(
				"create",
				Effect.gen(function* () {
					const writer = yield* fileWriter(approved);
					const chatId = canChange.reach.chat.value;
					if (writer.principal.chat !== chatId)
						return yield* new ActionForbidden({ proof: "CanChangeChat" });
					const replay = yield* replayFileWrite(writer);
					if (replay) return replay;
					return yield* createWrittenFile(
						blobs,
						ids,
						{ botId: writer.principal.bot, chatId },
						input,
						writer,
					);
				}),
			),

		replace: ({ reach }, approved, input) =>
			operation(
				"replace",
				Effect.gen(function* () {
					const writer = yield* fileWriter(approved);
					const found = yield* writtenFileIn(reach);
					const replay = yield* replayFileWrite(writer);
					if (replay) return replay;
					if (input.kind !== undefined && input.kind !== found.file.kind) {
						return yield* new FileKindFixed({ kind: found.file.kind });
					}
					yield* nextVersion(found, input.baseVersion);
					return yield* appendVersion(found.file, writer, input);
				}),
			),

		edit: ({ reach }, approved, input) =>
			operation(
				"edit",
				Effect.gen(function* () {
					const writer = yield* fileWriter(approved);
					const found = yield* writtenFileIn(reach);
					const replay = yield* replayFileWrite(writer);
					if (replay) return replay;
					yield* nextVersion(found, input.baseVersion);
					const current = yield* shownOrHidden(atVersion(found, input.baseVersion));
					const matches = current.content.split(input.oldText).length - 1;
					if (input.oldText === "" || matches !== 1)
						return yield* new FileEditTextUnmatched({ matches });
					return yield* appendVersion(found.file, writer, {
						baseVersion: input.baseVersion,
						content: current.content.replace(input.oldText, () => input.newText),
					});
				}),
			),
	});
});

export const layerNoDeps = processLayer(Layer.effect(Service, make));

export const layer = layerNoDeps;

interface NewWrittenFile {
	readonly kind: WrittenFileKind;
	readonly title: string;
	readonly content: string;
}

interface ReplaceWrittenFile {
	readonly baseVersion: number;
	readonly content: string;
	readonly title?: string;
	readonly kind?: WrittenFileKind;
}

interface EditWrittenFile {
	readonly baseVersion: number;
	readonly oldText: string;
	readonly newText: string;
}

interface FileWriter {
	readonly principal: BotPrincipal;
	readonly toolCallId: string;
}

const fileWriter = <P, X, Target>(
	approved: Approved<P, X, [Target], "files.write" | "files.edit">,
): Effect.Effect<FileWriter, ActionForbidden | ApprovalRefused> =>
	Effect.gen(function* () {
		const principal = approved.principal.value;
		if (principal._tag !== "BotForAsker" && principal._tag !== "AutomationRun") {
			return yield* new ActionForbidden({ proof: "CanWriteFileInTurn" });
		}
		const call = approved.call.value;
		if (call.kind !== "toolCall" || !isUuid(call.toolCall)) return yield* new ApprovalRefused();
		return { principal, toolCallId: call.toolCall };
	});

const fileWriteFence = ({ principal }: FileWriter) =>
	executionFence(principal.turn, principal.executionNumber);

const replayFileWrite = (writer: FileWriter) =>
	replayWrittenFile(fileWriteFence(writer), writer.toolCallId);

const recordFileWrite = <E>(
	writer: FileWriter | undefined,
	write: Effect.Effect<FileWritten, E, Database>,
) =>
	writer
		? commitWrittenFile(fileWriteFence(writer), writer.toolCallId, write)
		: transaction(Effect.map(write, (receipt) => ({ receipt, usedContent: true })));

const nextVersion = ({ file }: FoundFile, baseVersion: number) =>
	file.currentVersion === baseVersion
		? Effect.succeed(baseVersion + 1)
		: Effect.fail(new FileStale({ currentVersion: file.currentVersion }));

/** seedWrittenFile creates a file for a scripted showcase or test fixture. */
export const seedWrittenFile = (by: { botId: string; chatId: string }, input: NewWrittenFile) =>
	Effect.gen(function* () {
		const { fileId, kind, title, version } = yield* createWrittenFile(
			yield* BlobStore.Service,
			yield* Ids.Service,
			by,
			input,
		);
		return { id: fileId, kind, title, version };
	});

const createWrittenFile = (
	blobs: BlobStore.Interface,
	ids: Ids.Interface,
	by: { botId: string; chatId: string },
	input: NewWrittenFile,
	writer?: FileWriter,
) =>
	Effect.flatMap(ids.next, (fileId) =>
		withContent(blobs, ids, fileId, input.kind, input.content, (stored) =>
			recordFileWrite(
				writer,
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
					yield* insertVersion(written, 1, stored, by.botId);
					return {
						status: "written" as const,
						fileId: written.id,
						kind: written.kind,
						title: written.name,
						version: written.currentVersion,
					};
				}),
			),
		),
	);

/** withContent stages a unique blob and removes it if no version committed with it. */
const withContent = <E, R>(
	blobs: BlobStore.Interface,
	ids: Ids.Interface,
	fileId: string,
	kind: WrittenFileKind,
	content: string,
	record: (
		stored: StoredContent,
	) => Effect.Effect<{ receipt: FileWritten; usedContent: boolean }, E, R>,
) =>
	Effect.gen(function* () {
		if (content.length > MAX_FILE_CONTENT_CHARACTERS) {
			return yield* new FileContentTooLarge({ maxCharacters: MAX_FILE_CONTENT_CHARACTERS });
		}
		const versionId = yield* ids.next;
		const key = versionKey(fileId, versionId);
		const contentType = CONTENT_TYPES[kind];
		// Queued for deletion before the bytes are stored, once the write has had
		// time to record them, which deletes the queue row: bytes stored by a
		// process that stopped before recording them are deleted all the same.
		const now = yield* DateTime.now;
		const staged = yield* query((db) =>
			db
				.insert(blobDeletion)
				.values({
					prefix: key,
					dueAt: DateTime.toDateUtc(DateTime.addDuration(now, STAGED_CONTENT_GRACE)),
				})
				.returning({ id: blobDeletion.id }),
		).pipe(Effect.flatMap(writtenRow("blob_deletion")));
		const discard = blobs.delete(key).pipe(Effect.ignore);
		return yield* Effect.uninterruptibleMask((restore) =>
			Effect.gen(function* () {
				const { size } = yield* restore(
					blobs.put(key, {
						stream: Stream.succeed(new TextEncoder().encode(content)),
						contentType,
					}),
				).pipe(
					Effect.orDie,
					Effect.onError(() => discard),
				);
				const { receipt, usedContent } = yield* record({
					versionId,
					contentType,
					size,
					stagedDeletionId: staged.id,
				}).pipe(Effect.onError(() => discard));
				if (!usedContent) yield* discard;
				return receipt;
			}),
		);
	});

/** A version's content as kept in the blob store. */
interface StoredContent {
	versionId: string;
	contentType: string;
	/** In bytes. */
	size: number;
	/** The `blob_deletion` row that deletes the content unless a version records it. */
	stagedDeletionId: string;
}

/** How long a write has to record the content it stored before the content is deleted. */
const STAGED_CONTENT_GRACE = Duration.hours(1);

const CONTENT_TYPES: Record<WrittenFileKind, string> = {
	markdown: "text/markdown; charset=utf-8",
	html: "text/html; charset=utf-8",
};

/** Under the file's folder, `files/<fileId>`, which the `file_blob_deletion` trigger queues for deletion with the file. */
export function versionKey(fileId: string, versionId: string): BlobStore.Key {
	return BlobStore.key("files", fileId, "versions", versionId);
}

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
	outsideRun?: WrittenFile["outsideRun"];
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
			const select = writtenFilesWithCreator(db)
				.where(and(eq(file.id, fileId), isWritten, scope))
				.limit(1);
			return options.lock ? select.for("update", { of: file }) : select;
		});
		if (!row) return undefined;
		const outsideRun =
			row.triggerKind === "github" || row.triggerKind === "webhook" ? row.triggerKind : undefined;
		return { file: asWritten(row.file), creator: authorOf(row.creator), outsideRun };
	});

const requireWrittenFile = (fileId: string, chatId: string, lock = false) =>
	writtenFileWhere(fileId, eq(file.chatId, chatId), { lock }).pipe(
		Effect.filterOrFail(
			(found) => found !== undefined,
			() => new ResourceHidden({ resource: "file" }),
		),
	);

/** Files with the chat each was made in and the bot that made it, for a scope to narrow. */
const writtenFilesWithCreator = (db: Executor) =>
	db
		.select({
			file,
			creator: { id: bot.id, name: bot.name },
			triggerKind: automationRun.triggerKind,
		})
		.from(file)
		.innerJoin(placedChat, eq(placedChat.id, file.chatId))
		.innerJoin(listingChat, chatListingIt)
		.leftJoin(automationRun, eq(automationRun.chatId, file.chatId))
		.leftJoin(bot, eq(bot.id, file.createdByBotId));

/**
 * The chat that lists a file, joined beside `placedChat`, the chat it was
 * made in: that chat itself, or for an automation's run, the automation's
 * feed.
 */
const listingChat = alias(placedChat, "listing_chat");
const chatListingIt = eq(listingChat.id, sql`coalesce(${placedChat.rootChatId}, ${placedChat.id})`);

const listedWrittenFilesWhere = (scope: SQL | undefined) =>
	Effect.map(
		query((db) =>
			writtenFilesWithCreator(db).where(and(isWritten, scope)).orderBy(desc(file.updatedAt)),
		),
		(rows) => rows.map((row) => toListedWrittenFile(asWritten(row.file), authorOf(row.creator))),
	);

/**
 * A file on a message that members can open from a list: a sent attachment or a
 * bot's attachment, in a chat itself rather than in a run listed in one, as
 * only a chat's files are served.
 */
const isListedMessageFile = and(
	inArray(file.kind, ["attachment", "bot_attachment"]),
	isNotNull(file.messageId),
	eq(file.chatId, listingChat.id),
);

/** The files members see listed where `scope` holds: those bots wrote, and those on messages, newest change first. */
const listedWhere = (scope: SQL | undefined) =>
	Effect.map(
		query((db) =>
			db
				.select({
					file,
					creator: { id: bot.id, name: bot.name },
					uploader: member.name,
				})
				.from(file)
				.innerJoin(placedChat, eq(placedChat.id, file.chatId))
				.innerJoin(listingChat, chatListingIt)
				.leftJoin(message, eq(message.id, file.messageId))
				// The bot that wrote it, or that attached it to its reply.
				.leftJoin(bot, eq(bot.id, sql`coalesce(${file.createdByBotId}, ${message.authorBotId})`))
				.leftJoin(member, eq(member.id, file.uploaderId))
				.where(and(or(isWritten, isListedMessageFile), scope))
				.orderBy(desc(file.updatedAt)),
		),
		(rows) =>
			rows.map(
				({ file: row, creator, uploader }): ListedFile =>
					isWrittenKind(row.kind)
						? toListedWrittenFile(asWritten(row), authorOf(creator))
						: toListedMessageFile(
								row,
								row.kind === "attachment" ? uploader : (creator?.name ?? null),
							),
			),
	);

const toListedMessageFile = (row: FileRow, author: string | null): ListedMessageFile => ({
	id: row.id,
	chatId: row.chatId,
	kind: row.kind === "attachment" ? "attachment" : "bot_attachment",
	// A file on a message always has a name, type and size, by `file_source_valid`.
	name: row.name ?? "",
	contentType: row.contentType ?? "",
	size: row.size ?? 0,
	author,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

/** Versions with the bot that wrote each, for a condition to narrow. */
const versionsWithAuthor = (db: Executor) =>
	db
		.select({ version: fileVersion, author: { id: bot.id, name: bot.name } })
		.from(fileVersion)
		.leftJoin(bot, eq(bot.id, fileVersion.authorBotId));

const versionsOf = (fileId: string) =>
	Effect.map(
		query((db) =>
			versionsWithAuthor(db)
				.where(eq(fileVersion.fileId, fileId))
				.orderBy(desc(fileVersion.number)),
		),
		(rows) => rows.map((row) => toListedFileVersion(row.version, authorOf(row.author))),
	);

const versionRow = (fileId: string, number: number) =>
	Effect.map(
		query((db) =>
			versionsWithAuthor(db)
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
		// that can't be reached is an infrastructure fault, which a member's
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

/** Records the stored content as the file's version `number`, so its staged deletion goes. */
const insertVersion = (
	of: WrittenFileRow,
	number: number,
	{ versionId, contentType, size, stagedDeletionId }: StoredContent,
	botId: string,
) =>
	Effect.andThen(
		query((db) =>
			db.insert(fileVersion).values({
				id: versionId,
				fileId: of.id,
				fileKind: of.kind,
				number,
				contentType,
				size,
				authorBotId: botId,
			}),
		),
		query((db) => db.delete(blobDeletion).where(eq(blobDeletion.id, stagedDeletionId))),
	);

const toListedWrittenFile = (row: WrittenFileRow, creator: FileAuthor): ListedWrittenFile => ({
	id: row.id,
	chatId: row.chatId,
	kind: row.kind,
	title: row.name,
	version: row.currentVersion,
	createdBy: creator,
	createdAt: row.createdAt.toISOString(),
	updatedAt: row.updatedAt.toISOString(),
});

const toListedFileVersion = (row: FileVersionRow, author: FileAuthor): ListedFileVersion => ({
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
	...toListedWrittenFile(found.file, found.creator),
	...(found.outsideRun && { outsideRun: found.outsideRun }),
	content,
	shownVersion: toListedFileVersion(version, author),
});
