import { messageAuthorName } from "@sugabots/contracts";
import { and, asc, eq, gte } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { bot, member, message, placedChat } from "../../database/schema.ts";
import { messageTextWithPlacedParts } from "./message-text.ts";
import {
	participantColumns,
	quotedMessageColumns,
	toMessage,
	toReplyTo,
	withReplyTo,
} from "./participants.ts";
import { loadPlacedParts } from "./placed-parts.ts";

/**
 * What a system bot that works on a chat after a reply, such as the
 * Compaction bot, reads: the chat it works on, and its transcript. It
 * keeps its own turns in a system chat that `ChatStore`
 * opens.
 */

/** The chat a system bot works on, as much of it as preparing that work needs. */
interface SystemBotScope {
	chatId: string;
	workspaceId: string;
	chatTitle: string;
	/** The model of the bot whose reply asked for this work, which reads the chat next. */
	botModel: string | null;
}

/** One message of a transcript, as a system bot reads it. */
export interface TranscriptEntry {
	author: string;
	kind: "member" | "bot";
	content: string;
}

/**
 * The chat, if it still exists and still has the source message and
 * the bot whose reply asked for this work.
 */
export const loadSystemBotScope = Effect.fn("SystemBotChats.loadSystemBotScope")(function* (
	db: Executor,
	request: { chatId: string; botId: string; sourceMessageId: string },
) {
	const [row] = yield* db
		.select({
			chatId: placedChat.id,
			workspaceId: placedChat.workspaceId,
			chatTitle: placedChat.title,
			botModel: bot.model,
		})
		.from(placedChat)
		// The bot whose reply triggered the work, whose model is read: in a
		// chat with several bots it need not be the chat's.
		.innerJoin(bot, eq(bot.id, request.botId))
		.innerJoin(
			message,
			and(eq(message.id, request.sourceMessageId), eq(message.chatId, placedChat.id)),
		)
		.where(eq(placedChat.id, request.chatId))
		.limit(1);
	return row satisfies SystemBotScope | undefined;
});

/**
 * Every complete message in the chat, oldest first, or only those created
 * at or after `from`. A message with nothing to read,
 * such as a reply that only called tools that left no record, has no `entry`.
 */
export const loadTranscript = Effect.fn("SystemBotChats.loadTranscript")(function* (
	db: Executor,
	chatId: string,
	{ from }: { from?: Date } = {},
) {
	const rows = yield* db
		.select({
			message,
			...participantColumns,
		})
		.from(message)
		.leftJoin(member, eq(member.id, message.authorMemberId))
		.leftJoin(bot, eq(bot.id, message.authorBotId))
		.where(
			and(
				eq(message.chatId, chatId),
				eq(message.status, "complete"),
				from ? gte(message.createdAt, from) : undefined,
			),
		)
		.orderBy(asc(message.createdAt), asc(message.id));
	const placed = yield* loadPlacedParts(
		db,
		rows.map(({ message: row }) => row.id),
	);
	const quotedIds = rows.flatMap(({ message: row }) =>
		row.replyToMessageId ? [row.replyToMessageId] : [],
	);
	const quoted =
		quotedIds.length === 0
			? []
			: yield* db.query.message.findMany({
					where: { id: { in: quotedIds } },
					...quotedMessageColumns,
				});
	const quotedById = new Map(quoted.map((row) => [row.id, toReplyTo(row)]));
	return rows.map(({ message: row, ...author }) => {
		const hydrated = withReplyTo(
			toMessage(row, author, placed(row.id)),
			row.replyToMessageId ? quotedById.get(row.replyToMessageId) : undefined,
		);
		const content = messageTextWithPlacedParts(hydrated);
		const entry: TranscriptEntry | undefined = content
			? {
					author: messageAuthorName(hydrated.author),
					kind: hydrated.author.kind === "member" ? "member" : "bot",
					content,
				}
			: undefined;
		return { id: row.id, createdAt: row.createdAt, entry };
	});
});
