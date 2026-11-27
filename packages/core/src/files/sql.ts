import type { WrittenFileKind } from "@sugabots/contracts";
import { sql } from "drizzle-orm";
import {
	check,
	foreignKey,
	index,
	integer,
	pgTable,
	text,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import { chat, message, toolCall } from "../chats/sql.ts";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { bot, member } from "../workspaces/sql.ts";

/**
 * Where a file came from, which decides the columns it sets:
 * - `markdown` and `html`: a bot wrote it with its file tools. Its content is
 *   in `file_version`, and it has a title and a current version.
 * - `attachment`: a member added it to a message, unsent until that message is.
 * - `bot_attachment`: a bot attached it to its reply.
 * - `tool_result`: a tool call's result, too long to give the model whole.
 */
type FileKind = WrittenFileKind | "attachment" | "bot_attachment" | "tool_result";

/** The kinds a bot writes with its file tools, which alone have versions. */
export const WRITTEN_FILE_KINDS = ["markdown", "html"] as const satisfies readonly FileKind[];

/**
 * A file a member uploaded or a bot made, in the chat it was uploaded
 * or made in, through which it is reached and with which it goes.
 *
 * A written file's content is in `file_version`, in the blob store under
 * `files/<fileId>` (see `files.ts`); `currentVersion` is the number of the
 * latest one, and a write names the version it started from so a stale write
 * is refused rather than overwriting a newer one. Any other file's bytes are
 * one blob under its chat's folder (see `chat-file-store.ts`).
 */
export const file = pgTable(
	"file",
	{
		id: primaryKey(),
		chatId: uuid("chat_id")
			.notNull()
			.references(() => chat.id, { onDelete: "cascade" }),
		kind: text("kind").$type<FileKind>().notNull(),
		/**
		 * A written file's title; an attachment's name as the member's computer
		 * had it; a bot's attachment's, as the bot gave it. A tool result has none.
		 */
		name: text("name"),
		/** For all but a written file, whose versions each have their own. */
		contentType: text("content_type"),
		/** In bytes. For all but a written file, whose versions each have their own. */
		size: integer("size"),
		/** For a tool result: the call whose result this is. */
		toolCallId: uuid("tool_call_id").references(() => toolCall.id, { onDelete: "set null" }),
		/** For an attachment: who uploaded it, the only one who may send it while it is unsent. */
		uploaderId: uuid("uploader_id").references(() => member.id, { onDelete: "set null" }),
		/**
		 * For an attachment, the message it is on, unset until that message is
		 * sent; for a bot's attachment, the reply it was attached to.
		 */
		messageId: uuid("message_id").references(() => message.id, { onDelete: "cascade" }),
		/** For a file on a message: its place among the message's files, from 0. */
		position: integer("position"),
		/** For a written file: the bot that made it, kept unset when the bot goes, so the file survives it. */
		createdByBotId: uuid("created_by_bot_id").references(() => bot.id, {
			onDelete: "set null",
		}),
		/** For a written file: the number of its latest version. */
		currentVersion: integer("current_version"),
		createdAt: stamp("created_at"),
		updatedAt: updatedStamp("updated_at"),
	},
	(table) => [
		index("file_chat_updated_at_idx").on(table.chatId, table.updatedAt),
		index("file_message_idx").on(table.messageId),
		index("file_message_name_trigram_idx")
			.using("gin", table.name.op("gin_trgm_ops"))
			.where(sql`${table.messageId} is not null`),
		// What `file_version` points at, so a version is only ever a written file's.
		uniqueIndex("file_id_kind_idx").on(table.id, table.kind),
		check(
			"file_kind_valid",
			sql`${table.kind} in ('markdown', 'html', 'attachment', 'bot_attachment', 'tool_result')`,
		),
		check(
			"file_source_valid",
			sql`case ${table.kind}
				when 'attachment' then ${table.name} is not null and ${table.contentType} is not null
					and ${table.size} is not null and ${table.toolCallId} is null
					and (${table.messageId} is null) = (${table.position} is null)
					and ${table.createdByBotId} is null and ${table.currentVersion} is null
				when 'bot_attachment' then ${table.name} is not null and ${table.contentType} is not null
					and ${table.size} is not null and ${table.toolCallId} is null
					and ${table.uploaderId} is null and ${table.messageId} is not null
					and ${table.position} is not null
					and ${table.createdByBotId} is null and ${table.currentVersion} is null
				when 'tool_result' then ${table.name} is null and ${table.contentType} is not null
					and ${table.size} is not null and ${table.uploaderId} is null
					and ${table.messageId} is null and ${table.position} is null
					and ${table.createdByBotId} is null and ${table.currentVersion} is null
				else ${table.name} is not null and ${table.currentVersion} is not null
					and ${table.contentType} is null and ${table.size} is null
					and ${table.toolCallId} is null and ${table.uploaderId} is null
					and ${table.messageId} is null and ${table.position} is null
			end`,
		),
	],
);

/** An attachment whose message is not sent yet, which only its uploader knows of. */
export const unsentAttachment = sql`(${file.kind} = 'attachment' and ${file.messageId} is null)`;

export type FileRow = typeof file.$inferSelect;

/**
 * One version of a written file, numbered from 1. Its content is in the blob
 * store under `files/<fileId>/versions/<id>` (see `files.ts`), which the
 * `file_blob_deletion` trigger queues for deletion with the file.
 */
export const fileVersion = pgTable(
	"file_version",
	{
		id: primaryKey(),
		fileId: uuid("file_id").notNull(),
		/** The file's kind, which only a written file's can be. */
		fileKind: text("file_kind").$type<WrittenFileKind>().notNull(),
		number: integer("number").notNull(),
		contentType: text("content_type").notNull(),
		/** In bytes. */
		size: integer("size").notNull(),
		authorBotId: uuid("author_bot_id").references(() => bot.id, { onDelete: "set null" }),
		createdAt: stamp("created_at"),
	},
	(table) => [
		uniqueIndex("file_version_number_idx").on(table.fileId, table.number),
		foreignKey({
			name: "file_version_file_fkey",
			columns: [table.fileId, table.fileKind],
			foreignColumns: [file.id, file.kind],
		}).onDelete("cascade"),
		check("file_version_file_kind_valid", sql`${table.fileKind} in ('markdown', 'html')`),
	],
);

export type FileVersionRow = typeof fileVersion.$inferSelect;
