import { type ConversationKind, messageAuthorName } from "@sugabots/contracts";
import { and, asc, eq, gte } from "drizzle-orm";
import { Effect } from "effect";
import type { Executor } from "../../database/database.ts";
import { bot, message, placedConversation, user } from "../../database/schema.ts";
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
 * What the system bots that work on a conversation after a reply (the
 * Summariser and the Compaction bot) read: the conversation they work on, and
 * its transcript. Each keeps its own turns in a system conversation that
 * `ConversationRepository` opens.
 */

/** The conversation a system bot works on, as much of it as preparing that work needs. */
interface SystemBotScope {
	conversationId: string;
	workspaceId: string;
	conversationKind: ConversationKind;
	/** The bot the conversation is with, as `placedConversation` reads it. */
	conversationBotId: string | null;
	conversationTitle: string;
	/** The model of the bot whose reply asked for this work, which reads the conversation next. */
	botModel: string | null;
}

/** One message of a transcript, as a system bot reads it. */
export interface TranscriptEntry {
	author: string;
	kind: "person" | "bot";
	content: string;
}

/**
 * The conversation, if it still exists and still has the source message and
 * the bot whose reply asked for this work.
 */
export const loadSystemBotScope = Effect.fn("SystemBotConversations.loadSystemBotScope")(function* (
	db: Executor,
	request: { conversationId: string; botId: string; sourceMessageId: string },
) {
	const [row] = yield* db
		.select({
			conversationId: placedConversation.id,
			workspaceId: placedConversation.workspaceId,
			conversationKind: placedConversation.kind,
			conversationBotId: placedConversation.botId,
			conversationTitle: placedConversation.title,
			botModel: bot.model,
		})
		.from(placedConversation)
		// The bot whose reply triggered the work, whose model is read: in a
		// conversation with several bots it need not be the conversation's.
		.innerJoin(bot, eq(bot.id, request.botId))
		.innerJoin(
			message,
			and(
				eq(message.id, request.sourceMessageId),
				eq(message.conversationId, placedConversation.id),
			),
		)
		.where(eq(placedConversation.id, request.conversationId))
		.limit(1);
	return row satisfies SystemBotScope | undefined;
});

/**
 * Every complete message in the conversation, oldest first, or only those created
 * at or after `from`. A message with nothing to read,
 * such as a reply that only called tools that left no record, has no `entry`.
 */
export const loadTranscript = Effect.fn("SystemBotConversations.loadTranscript")(function* (
	db: Executor,
	conversationId: string,
	{ from }: { from?: Date } = {},
) {
	const rows = yield* db
		.select({
			message,
			...participantColumns,
		})
		.from(message)
		.leftJoin(user, eq(user.id, message.authorUserId))
		.leftJoin(bot, eq(bot.id, message.authorBotId))
		.where(
			and(
				eq(message.conversationId, conversationId),
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
					kind: hydrated.author.kind === "person" ? "person" : "bot",
					content,
				}
			: undefined;
		return { id: row.id, createdAt: row.createdAt, entry };
	});
});
