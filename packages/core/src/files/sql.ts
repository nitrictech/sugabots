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
import { conversation, message, toolCall } from "../conversations/sql.ts";
import { primaryKey, stamp, updatedStamp } from "../database/sql.ts";
import { bot, user } from "../workspaces/sql.ts";

/**
 * Where a file came from, which decides the columns it sets:
 * - `document` and `html`: a bot wrote it with its file tools. Its content is
 *   in `file_version`, and it has a title and a current version.
 * - `upload`: a person uploaded it, unsent until it is attached to a message.
 * - `bot_attachment`: a bot attached it to its reply.
 * - `tool_result`: a tool call's result, too long to give the model whole.
 */
export type FileKind = WrittenFileKind | "upload" | "bot_attachment" | "tool_result";

/** The kinds a bot writes with its file tools, which alone have versions. */
export const WRITTEN_FILE_KINDS = ["document", "html"] as const satisfies readonly FileKind[];

/**
 * A file a person uploaded or a bot made, in the conversation it was uploaded
 * or made in, through which it is reached and with which it goes.
 *
 * A written file's content is in `file_version`, in the blob store under
 * `artifacts/<fileId>` (see `files.ts`); `currentVersion` is the number of the
 * latest one, and a write names the version it started from so a stale write
 * is refused rather than overwriting a newer one. Any other file's bytes are
 * one blob under its conversation's folder (see `conversation-files.ts`).
 */
export const file = pgTable(
	"file",
	{
		id: primaryKey(),
		conversationId: uuid("conversation_id")
			.notNull()
			.references(() => conversation.id, { onDelete: "cascade" }),
		kind: text("kind").$type<FileKind>().notNull(),
		/**
		 * A written file's title; an upload's name as the person's computer had
		 * it; an attachment's, as the bot gave it. A tool result has none.
		 */
		name: text("name"),
		/** For all but a written file, whose versions each have their own. */
		contentType: text("content_type"),
		/** In bytes. For all but a written file, whose versions each have their own. */
		size: integer("size"),
		/** For a tool result: the call whose result this is. */
		toolCallId: uuid("tool_call_id").references(() => toolCall.id, { onDelete: "set null" }),
		/** For an upload: who uploaded it, the only one who may attach it while it is unsent. */
		uploaderId: uuid("uploader_id").references(() => user.id, { onDelete: "set null" }),
		/**
		 * For an upload, the message it is attached to, unset until that message
		 * is sent; for a bot's attachment, the reply it was attached to.
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
		index("file_conversation_updated_at_idx").on(table.conversationId, table.updatedAt),
		index("file_message_idx").on(table.messageId),
		// What `file_version` points at, so a version is only ever a written file's.
		uniqueIndex("file_id_kind_idx").on(table.id, table.kind),
		check(
			"file_kind_valid",
			sql`${table.kind} in ('document', 'html', 'upload', 'bot_attachment', 'tool_result')`,
		),
		check(
			"file_source_valid",
			sql`case ${table.kind}
				when 'upload' then ${table.name} is not null and ${table.contentType} is not null
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

export type FileRow = typeof file.$inferSelect;

/**
 * One version of a written file, numbered from 1. Its content is in the blob
 * store under `artifacts/<fileId>/versions/<id>` (see `files.ts`), which the
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
		check("file_version_file_kind_valid", sql`${table.fileKind} in ('document', 'html')`),
	],
);

export type FileVersionRow = typeof fileVersion.$inferSelect;
